/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { evaluateExpr } from './dtsUtil';

export type IncludeStatement = { loc: vscode.Location, dst: vscode.Uri };

export type Defines = { [name: string]: Define };
export type ProcessedFile = { lines: Line[], defines: Defines, includes: IncludeStatement[] };

export function toDefines(list: Define[]): Defines {
    const defines: Defines = {};
    list.forEach(m => defines[m.name] = m);
    return defines;
}

function replace(text: string, macros: MacroInstance[]) {
    // Replace values from back to front:
    [...macros].sort((a, b) => b.start - a.start).forEach(m => {
        text = text.slice(0, m.start) + m.insert + text.slice(m.start + m.raw.length);
    });

    return text;
}

function parseArgs(text: string): {args: string[], raw: string} {
    const args = new Array<string>();
    const start = text.match(/^\s*\(/);
    if (!start) {
        return {args, raw: ''};
    }
    text = text.slice(start[0].length);
    let depth = 1;
    let arg = '';
    let raw = start[0];

    while (text.length) {
        const paramMatch = text.match(/^([^(),]*)(.)/);
        if (!paramMatch) {
            return { args: [], raw };
        }

        raw += paramMatch[0];
        arg += paramMatch[0];
        text = text.slice(paramMatch[0].length);
        if (paramMatch[2] === '(') {
            depth++;
        } else {
            if (depth === 1) {
                args.push(arg.slice(0, arg.length-1).trim());
                arg = '';
            }

            if (paramMatch[2] === ')') {
                if (!--depth) {
                    break;
                }
            }
        }
    }

    if (depth) {
        return {args: [], raw};
    }

    return { args, raw };
}

function resolve(text: string, defines: Defines, loc: vscode.Location): string {
    return replace(text, findReplacements(text, defines, loc));
}

function findReplacements(text: string, defines: Defines, loc: vscode.Location): MacroInstance[] {
    const macros = new Array<MacroInstance>();
    const regex = new RegExp(/\w+|(?<!\\)"/g);
    let inString = false;
    let match: RegExpMatchArray;
    while ((match = regex.exec(text))) {
        if (match[0] === '"') {
            inString = !inString;
            continue;
        }

        if (inString) {
            continue;
        }

        const macro = defines[match[0]];
        if (!macro) {
            continue;
        }
        if (!macro.args) {
            const val = resolve(macro.value(loc), defines, loc);
            macros.push(new MacroInstance(macro, match[0], val, match.index));
            continue;
        }

        const {args, raw: rawArgs} = parseArgs(text.slice(match.index + match[0].length));
        regex.lastIndex = match.index + match[0].length + rawArgs.length;

        /* Replace macro arguments:
         * - Parameters that start with a single "#" will be converted to double quoted strings,
         *   and if they contain defines, they won't be expanded.
         * - Values with preceeded or followed by "##" will be replaced with their value, and
         *   if they contain defines, they won't be expanded.
         * - Other instances are replaced by their values, and any defines will be expanded.
         */
        const replacements: any = {};
        macro.args.forEach((arg, i, all) => {
            if (i == all.length - 1) {
                if (arg === '...') {
                    replacements['__VA_ARGS__'] = args.slice(i).join(', ');
                    return;
                }

                if (arg.endsWith('...')) {
                    replacements[arg.replace(/\.\.\.$/, '')] = args.slice(i).join(', ');
                    return;
                }
            }
            replacements[arg] = args[i];
        });
        let insert = macro.value(loc).replace(/(?:,\s*##\s*(__VA_ARGS__)|(?<=##)\s*(\w+)\b|\b(\w+)\s*(?=##)|(?<!#)#\s*(\w+)\b|\b(\w+)\b)/g,
            (original, vaArgs, concat1, concat2, stringified, raw) => {
                let v: any = replacements[vaArgs];
                if (v !== undefined) {
                    // If the value is empty, we'll consume the comma:
                    if (v) {
                        return resolve(', ' + v, defines, loc);
                    }

                    return resolve(v, defines, loc);
                }

                v = replacements[concat1] ?? replacements[concat2];
                if (v !== undefined) {
                    return v;
                }

                v = replacements[stringified];
                if (v !== undefined) {
                    return `"${v}"`;
                }

                v = replacements[raw];
                if (v !== undefined) {
                    return resolve(v, defines, loc);
                }

                return original;
            });


        insert = insert.replace(/\s*##\s*/g, '');

        macros.push(new MacroInstance(macro, match[0] + rawArgs, resolve(insert, defines, loc), match.index));
    }

    return macros;
}

export class Define {
    private _value: string;
    name: string;
    args?: string[]
    definition?: Line;
    undef?: Line;

    get isDefined() {
        return !this.undef;
    }

    value(loc: vscode.Location) {
        return this._value;
    }

    constructor(name: string, value: string, definition?: Line, args?: string[]) {
        this.name = name;
        this.definition = definition;
        this._value = value;
        this.args = args;
    }
}

export class LineMacro extends Define {
    value(loc: vscode.Location) {
        return (loc.range.start.line + 1).toString();
    }

    constructor() {
        super('__LINE__', '0');
    }
}

export class FileMacro extends Define {
    private cwd: string;

    value(loc: vscode.Location) {
        return `"${path.relative(this.cwd, loc.uri.fsPath).replace(/\\/g, '\\\\')}"`;
    }

    constructor(cwd: string) {
        super('__FILE__', '<unknown>');
        this.cwd = cwd;
    }
}

export class CounterMacro extends Define {
    private number = 0;

    value(loc: vscode.Location) {
        return (this.number++).toString();
    }

    constructor() {
        super('__COUNTER__', '0');
    }
}

export class MacroInstance {
    raw: string;
    insert: string;
    start: number;
    macro: Define;

    constructor(macro: Define, raw: string, insert: string, start: number) {
        this.macro = macro;
        this.raw = raw;
        this.insert = insert;
        this.start = start;
    }

    contains(col: number) {
        return col >= this.start && col < this.start + this.raw.length;
    }
}

function readLines(doc: vscode.TextDocument): Line[] | null {
    try {
        const text = doc.getText();
        return text.split(/\r?\n/g).map((line, i) => new Line(line, i, doc.uri));
    } catch (e) {
        return null;
    }
}

function evaluate(text: string, loc: vscode.Location, defines: Defines): any {
    text = resolve(text, defines, loc);
    try {
        const diags = new Array<vscode.Diagnostic>();
        const result = evaluateExpr(text, loc.range.start, diags);
        return result;
    } catch (e) {
        // TODO: handle this
    }

    return 0;
}

export async function preprocess(doc: vscode.TextDocument, defines: Defines, includes: string[]): Promise<ProcessedFile> {
    const timeStart = process.hrtime();
    const result: ProcessedFile = {
        lines: new Array<Line>(),
        defines: <Defines>{
            '__FILE__': new FileMacro(path.dirname(doc.uri.fsPath)),
            '__LINE__': new LineMacro(),
            '__COUNTER__': new CounterMacro(),
            ...defines,
        },
        includes: new Array<IncludeStatement>(),
    };

    let rawLines = readLines(doc);
    if (rawLines === null) {
        return result;
    }

    const scopes: {line: Line, condition: boolean}[] = [];
    const once = new Array<vscode.Uri>();

    while (rawLines.length) {
        const line = rawLines.splice(0, 1)[0];
        let text = line.text;

        try {
            text = text.replace(/\/\/.*/, '');
            text = text.replace(/\/\*.*?\*\//, '');

            const blockComment = text.match(/\/\*.*/);
            if (blockComment) {
                text = text.replace(blockComment[0], '');
                while (rawLines) {
                    const blockEnd = rawLines[0].text.match(/^.*?\*\//);
                    if (blockEnd) {
                        rawLines[0].text = rawLines[0].text.slice(blockEnd[0].length);
                        break;
                    }

                    rawLines.splice(0, 1);
                }
            }

            const directive = text.match(/^\s*#\s*(\w+)/);
            if (directive) {
                while (text.endsWith('\\') && rawLines.length) {
                    text = text.slice(0, text.length - 1) + ' ' + rawLines.splice(0, 1)[0].text;
                }

                let value =  text.match(/^\s*#\s*(\w+)\s*(.*)/)[2].trim();

                if (directive[1] === 'if') {
                    if (!value) {
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    value = value.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                        return result.defines[define]?.isDefined ? '1' : '0';
                    });

                    scopes.push({line: line, condition: !!evaluate(value, line.location, result.defines)});
                    continue;
                }

                if (directive[1] === 'ifdef') {
                    if (!value) {
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    scopes.push({ line: line, condition: result.defines[value]?.isDefined });
                    continue;
                }

                if (directive[1] === 'ifndef') {
                    if (!value) {
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    scopes.push({ line: line, condition: !result.defines[value]?.isDefined });
                    continue;
                }

                if (directive[1] === 'else') {
                    if (!scopes.length) {
                        continue;
                    }

                    scopes[scopes.length - 1].condition = !scopes[scopes.length - 1].condition;
                    continue;
                }

                if (directive[1] === 'elif') {

                    if (!scopes.length) {
                        continue;
                    }

                    if (!value) {
                        scopes.push({line: line, condition: false});
                        continue;
                    }

                    if (scopes[scopes.length - 1].condition) {
                        scopes[scopes.length - 1].condition = false;
                        continue;
                    }

                    let condition = resolve(value, result.defines, line.location);
                    condition = condition.replace(new RegExp(`defined\\((.*?)\\)`, 'g'), (t, define) => {
                        return result.defines[define]?.isDefined ? '1' : '0';
                    });

                    scopes[scopes.length - 1].condition = evaluate(condition, line.location, result.defines);
                    continue;
                }

                if (directive[1] === 'endif') {
                    if (!scopes.length) {
                        continue;
                    }

                    scopes.pop();
                    continue;
                }

                // Skip everything else inside a disabled scope:
                if (!scopes.every(c => c.condition)) {
                    continue;
                }

                if (directive[1] === 'define') {
                    const define = value.match(/^(\w+)(?:\((.*?)\))?\s*(.*)/);
                    if (!define) {
                        continue;
                    }

                    const existing = result.defines[define[1]];
                    if (existing && !existing.undef) {
                        continue;
                    }

                    const macro = existing ?? new Define(define[1], define[3], line, define[2]?.split(',').map(a => a.trim()));
                    macro.undef = undefined;
                    result.defines[macro.name] = macro;
                    continue;
                }

                if (directive[1] === 'undef') {
                    const undef = value.match(/^\w+/);
                    if (!value) {
                        continue;
                    }

                    const define = result.defines[undef[0]];
                    if (!define || define.undef) {
                        continue;
                    }

                    define.undef = line;
                    continue;
                }

                if (directive[1] === 'pragma') {
                    if (value === 'once') {
                        if (once.some(uri => uri.fsPath === line.uri.fsPath)) {
                            const lines = rawLines.findIndex(l => l.uri.fsPath !== line.uri.fsPath);
                            if (lines > 0) {
                                rawLines.splice(0, lines);
                            }
                            continue;
                        }

                        once.push(line.uri);
                    }
                    continue;
                }

                if (directive[1] === 'include') {
                    const include = value.replace(/(?:"([^\s">]+)"|<([^\s">]+)>)/g, '$1$2').trim();
                    if (!include) {
                        continue;
                    }

                    const file = [path.resolve(path.dirname(line.uri.fsPath)), ...includes].map(dir => path.resolve(dir, include)).find(path => fs.existsSync(path));
                    if (!file) {
                        continue;
                    }

                    const uri = vscode.Uri.file(file);

                    const start = text.indexOf(value);
                    result.includes.push({ loc: new vscode.Location(line.uri, new vscode.Range(line.number, start, line.number, start + value.length)), dst: uri });

                    // inject the included file's lines. They will be the next to be processed:
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const lines = readLines(doc);
                    if (lines === null) {
                    } else {
                        rawLines = [...lines, ...rawLines];
                    }
                    continue;
                }

                if (directive[1] === 'error') {
                    continue;
                }
            }

            if (!text) {
                continue;
            }

            if (!scopes.every(c => c.condition)) {
                continue;
            }

            result.lines.push(new Line(text, line.number, line.uri, findReplacements(text, result.defines, line.location)));
        } catch (e) {
            // TODO: handle this
        }
    }

    const procTime = process.hrtime(timeStart);
    // console.log(`Preprocessed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);

    return result;
}

export class Line {
    raw: string;
    text: string;
    number: number;
    macros: MacroInstance[];
    location: vscode.Location;

    get length(): number {
        return this.text.length;
    }

    rawPos(range: vscode.Range): vscode.Range;
    rawPos(position: vscode.Position, earliest: boolean): number;
    rawPos(offset: number, earliest: boolean): number;

    /**
     * Remap a location in the processed text to a location in the raw input text (real human readable location)
     *
     * For instance, if a processed line is
     *
     * foo bar 1234
     *
     * and the unprocessed line is
     *
     * foo MACRO_1 MACRO_2
     *
     * the outputs should map like this:
     *
     * remap(0) -> 0
     * remap(4) -> 4 (from the 'b' in bar)
     * remap(5) -> 4 (from the 'a' in bar)
     * remap(5, true) -> 6 (from the 'a' in bar)
     * remap(9) -> 8 (from the '2' in 1234)
     *
     * @param loc Location in processed text
     * @param earliest Whether to get the earliest matching position
     */
    rawPos(loc: vscode.Position | vscode.Range | number, earliest=true) {
        if (loc instanceof vscode.Position) {
            return new vscode.Position(loc.line, this.rawPos(loc.character, earliest));
        }

        if (loc instanceof vscode.Range) {
            return new vscode.Range(loc.start.line, this.rawPos(loc.start, true), loc.end.line, this.rawPos(loc.end, false));
        }

        this.macros.find(m => {
            loc = <number>loc; // Just tricking typescript :)
            if (m.start > loc) {
                return true; // As macros are sorted by their start pos, there's no need to go through the rest
            }

            // Is inside macro
            if (loc < m.start + m.insert.length) {
                loc = m.start;
                if (!earliest) {
                    loc += m.raw.length; // clamp to end of macro
                }
                return true;
            }

            loc += m.raw.length - m.insert.length;
        });

        return loc;
    }

    contains(uri: vscode.Uri, pos: vscode.Position) {
        return uri.toString() === this.location.uri.toString() && this.location.range.contains(pos);
    }

    get uri() {
        return this.location.uri;
    }

    macro(pos: vscode.Position) {
        return this.macros.find(m => m.contains(pos.character));
    }

    constructor(raw: string, number: number, uri: vscode.Uri, macros: MacroInstance[]=[]) {
        this.raw = raw;
        this.number = number;
        this.macros = macros;
        this.location = new vscode.Location(uri, new vscode.Range(this.number, 0, this.number, this.raw.length));
        this.text = replace(raw, this.macros);
    }
}
