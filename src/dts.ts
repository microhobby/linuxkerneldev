/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Define, preprocess, Defines, ProcessedFile } from './preprocessor';
import { NodeType, TypeLoader } from './dtsTypes';
import { ParserState } from './dtsParser';
import { isTyping } from './util';

abstract class PropertyValue {
    val: any;
    loc: vscode.Location;

    constructor(val: any, loc: vscode.Location) {
        this.val = val;
        this.loc = loc;
    }

    contains(pos: vscode.Position, uri: vscode.Uri) {
        return this.loc.uri.toString() === uri.toString() && this.loc.range.contains(pos);
    }

    abstract toString(raw?: boolean): string;
}

export class StringValue extends PropertyValue {
    val: string;

    constructor(val: string, loc: vscode.Location) {
        super(val, loc);
    }

    static match(state: ParserState): StringValue {
        const string = state.match(/^"(.*?)"/);
        if (string) {
            return new StringValue(string[1], state.location());
        }
    }

    toString(raw=false) {
        if (raw) {
            return this.val;
        }

        return `"${this.val}"`;
    }
}

export class BoolValue extends PropertyValue {
    val: boolean;

    constructor(loc: vscode.Location) {
        super(true, loc);
    }

    toString(raw=false): string {
        return this.val.toString();
    }
}

export class IntValue extends PropertyValue {
    raw: string;
    val: number;

    protected constructor(raw: string, val: number, loc: vscode.Location) {
        super(val, loc);
        this.raw = raw;
    }

    static match(state: ParserState): IntValue {
        const number = state.match(/^(0x[\da-fA-F]+|\d+)[uUlL]*\b/);
        if (number) {
            const loc = state.location();
            // If the raw value is a macro, we'll show that when printing a human readable version:
            if (state.getLine(loc.uri, loc.range.start)?.macro(loc.range.start)?.insert !== number[0]) {
                return new IntValue(number[0], parseInt(number[1]), loc);
            }

            const raw = state.raw(loc);
            return new IntValue(raw, parseInt(number[1]), loc);
        }
    }

    apply(newValue: number) {
        return new IntValue(newValue.toString(), newValue, this.loc);
    }

    toString(raw=false): string {
        if (raw) {
            return this.raw;
        }

        return `<${this.raw}>`;
    }
}

export class Expression extends IntValue {
    static match(state: ParserState): Expression {
        const start = state.freeze();
        let m = state.match(/^\(/);
        if (!m) {
            return undefined;
        }

        let level = 1;
        let text = '(';
        while (level !== 0) {
            m = state.match(/^\s*(?:(?:<<|>>|&&|\|\||[!=<>]=|[|&~^<>!=+/*-]|\s*|0x[\da-fA-F]+|[\d.]+|'.')\s*)*([()])/);
            if (!m) {
                break;
            }

            text += m[0];
            if (m[1] === '(') {
                level++;
            } else {
                level--;
            }
        }

        const loc = state.location(start);

        try {
            // JS doesn't support single-character arithmetic, so we need to convert those to numbers first:
            const value = eval(text.replace(/'(.)'/g, (_, char: string) => char.charCodeAt(0).toString()));
            // If the raw value is a macro, we'll show that when printing a human readable version:
            const macroExpansion = state.getLine(loc.uri, loc.range.start)?.macro(loc.range.start)?.insert.trim();
            if (macroExpansion && macroExpansion !== text.trim()) {
                return new Expression(text, value, loc);
            }

            const raw = state.raw(loc);
            return new Expression(raw, value, loc);
        } catch (e) {
            // TODO: handle this
        }
    }

    toString(raw=true) {
        if (raw) {
            return this.raw;
        }

        return `<${this.val}>`;
    }
}

export class ArrayValue extends PropertyValue {
    val: (PHandle | IntValue | Expression)[];
    private constructor(value: (PHandle | IntValue | Expression)[], loc: vscode.Location) {
        super(value, loc);
    }

    static match(state: ParserState): ArrayValue {
        const start = state.freeze();
        const phandleArray = state.match(/^</);
        if (!phandleArray) {
            return undefined;
        }

        const elems = [IntValue, PHandle, Expression];
        const values: (PHandle | IntValue | Expression)[] = [];

        while (state.skipWhitespace() && !state.match(/^>/)) {
            let match: PHandle | IntValue | Expression | undefined;
            elems.find(e => match = e.match(state));
            if (match) {
                values.push(match);
                continue;
            }

            const unbracedExpression = state.match(/^([+*/|!^-]|&&|<<|>>|==)/);
            if (unbracedExpression) {
                continue;
            }

            // Unexpected data: Keep going until a potential closing bracket or semicolon
            const startOfError = state.freeze();
            state.skipToken();
            let endOfError = state.freeze();

            while (state.skipWhitespace()) {
                const newProp = state.match(/^[=<{}]/);
                if (newProp) {
                    break;
                }

                const terminators = state.match(/^[>;}]/);
                if (terminators) {
                    if (terminators[0] === '>') {
                    } else {
                        if (terminators[0] === ';') {
                            // Reset to right before this to avoid getting the "Missing semicolon" error
                            state.reset(endOfError);
                        }
                    }

                    break;
                }

                state.skipToken();
                endOfError = state.freeze();
            }

            break;
        }

        return new ArrayValue(values, state.location(start));
    }

    cellAt(pos: vscode.Position, uri: vscode.Uri) {
        return this.val.find(v => v.contains(pos, uri));
    }

    get length() {
        return this.val.length;
    }

    isNumberArray() {
        return this.val.every(v => v instanceof IntValue);
    }

    isNumber() {
        return (this.val.length === 1) && (this.val[0] instanceof IntValue);
    }

    isPHandle() {
        return (this.val.length === 1) && (this.val[0] instanceof IntValue);
    }

    isPHandleArray() {
        return this.val.every(v => v instanceof PHandle);
    }

    toString(raw=false) {
        if (raw && this.val.length === 1) {
            return this.val[0].toString(raw);
        }

        return `<${this.val.map(v => v.toString(true)).join(' ')}>`;
    }
}

export class BytestringValue extends PropertyValue {
    val: number[];
    private constructor(value: number[], loc: vscode.Location) {
        super(value, loc);
    }

    get length() {
        return this.val.length;
    }

    static match(state: ParserState): BytestringValue {
        if (!state.match(/^\[/)) {
            return;
        }

        const start = state.freeze();
        const bytes = new Array<number>();
        let match: RegExpMatchArray;
        while ((match = state.match(/^\s*([\da-fA-F]{2})/))) {
            bytes.push(parseInt(match[1], 16));
        }

        return new BytestringValue(bytes, state.location(start));
    }

    toString() {
        return `[ ${this.val.map(v => (v < 0x10 ? '0' : '') + v.toString(16)).join(' ')} ]`;
    }
}

export class PHandle extends PropertyValue {
    val: string;
    kind: 'ref' | 'pathRef' | 'string' | 'invalid';

    private constructor(value: string, loc: vscode.Location, kind: 'ref' | 'pathRef' | 'string' | 'invalid') {
        super(value, loc);
        this.kind = kind;
    }

    is(node: Node) {
        if (this.kind === 'ref') {
            const labelName = this.val.slice(1);
            return node.labels().includes(labelName);
        }

        return this.val === node.path;
    }

    static match(state: ParserState): PHandle {
        let phandle = state.match(/^&\{([\w/@-]+)\}/); // path reference
        if (phandle) {
            return new PHandle(phandle[1], state.location(), 'pathRef');
        }

        phandle = state.match(/^&[\w-]+/);
        if (phandle) {
            return new PHandle(phandle[0], state.location(), 'ref');
        }
        // can be path:
        phandle = state.match(/^"(.+?)"/); // deprecated?
        if (phandle) {
            return new PHandle(phandle[1], state.location(), 'string');
        }

        // Incomplete:
        phandle = state.match(/^&/);
        if (phandle) {
            return new PHandle(phandle[0], state.location(), 'invalid');
        }
    }

    toString(raw=true) {
        switch (this.kind) {
        case 'ref':
            return raw ? this.val : `<${this.val}>`;
        case 'pathRef':
            return raw ? `&{${this.val}}` : `<&{${this.val}}>`;
        case 'string':
            return `"${this.val}"`;
        case 'invalid':
            return '';
        }
    }
}

function parsePropValue(state: ParserState) {
    const elems: PropertyValue[] = [];

    const valueTypes = [ArrayValue, StringValue, BytestringValue, PHandle];
    let missingComma: vscode.Location;

    while (state.skipWhitespace()) {
        if (state.peek(/^;/)) {
            break;
        }

        if (missingComma) {
            missingComma = null;
        }

        if (elems.length > 0) {
            if (!state.match(/^,/)) {
                /* Found a missing comma, but will only emit comma error if we manage
                 * to parse another property value, as this could also just mean a missing
                 * semicolon.
                 */
                missingComma = state.location();
            }

            state.skipWhitespace();
        }

        let match: PropertyValue;
        valueTypes.find(type => match = type.match(state));
        if (match) {
            elems.push(match);
            continue;
        }

        // Easy to miss brackets around numbers.
        const number = state.match(/^(0x[\da-fA-F]+|\d+)/);

        /* As none of the value types matched, there's a format error in this value.
         * We'll just exit without consuming the next token, as this is likely a missing semicolon.
         */
        return elems;
    }

    if (elems.length === 0) {
        return [new BoolValue(state.location())];
    }

    return elems;
}

type PHandleEntry = { target: PHandle, cells: (IntValue | Expression)[] };

export class Property {
    name: string;
    labels?: string[];
    value: PropertyValue[];
    loc: vscode.Location;
    fullRange: vscode.Range;
    entry: NodeEntry;

    constructor(name: string, loc: vscode.Location, state: ParserState, entry: NodeEntry, labels: string[]=[]) {
        this.name = name;
        this.loc = loc;
        this.labels = labels;
        this.entry = entry;
        this.value = parsePropValue(state);
        this.fullRange = new vscode.Range(loc.range.start, state.location().range.end);
    }

    get path() {
        return this.node.path + this.name;
    }

    get node() {
        return this.entry.node;
    }

    toString(indent=0): string {
        if (this.value.length === 1 && this.value[0] instanceof BoolValue) {
            return `${this.name}`;
        }

        return `${this.name} = ${this.valueString(indent + this.name.length + 3)}`;
    }

    valueString(indent=0): string {
        if (this.value === undefined) {
            return '?';
        }

        if (this.boolean) {
            return 'true';
        }

        const values = this.value.map(v => v.toString());
        if (values.length > 1 && indent + values.join(', ').length > 80) {
            return values.join(',\n' + ' '.repeat(indent));
        }

        return values.join(', ');
    }

    get valueLoc() {
        const range = this.value.reduce((union, v) => {
            if (union) {
                return union.union(v.loc.range);
            }

            return v.loc.range;
        }, <vscode.Range>undefined);

        if (range) {
            return new vscode.Location(this.loc.uri, range);
        }

        return this.loc; // better than nothing
    }

    get fullLoc() {
        if (this.value.length) {
            return new vscode.Location(this.loc.uri, this.loc.range.union(this.value[this.value.length - 1].loc.range)); // better than nothing
        }

        return this.loc;
    }

    get boolean() {
        if (this.value.length === 1 && (this.value[0] instanceof BoolValue)) {
            return true;
        }
    }

    get number() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.length === 1 && (this.value[0].val[0] instanceof IntValue)) {
            return this.value[0].val[0].val as number;
        }
    }

    get string() {
        if (this.value.length === 1 && (this.value[0] instanceof StringValue)) {
            return this.value[0].val as string;
        }
    }

    get singleVal() {
        if (this.value.length !== 1) {
            return;
        }

        const val = this.value[0];

        if (val instanceof ArrayValue && val.length === 1) {
            return val.val[0].val;
        }

        if (val instanceof StringValue || val instanceof BoolValue || val instanceof IntValue) {
            return val.val;
        }
    }

    get pHandle() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.length === 1 && (this.value[0].val[0] instanceof PHandle)) {
            return this.value[0].val[0] as PHandle;
        }
        if (this.value.length === 1 && (this.value[0] instanceof PHandle)) {
            return this.value[0] as PHandle;
        }
    }

    get bytestring() {
        if (this.value.length === 1 && (this.value[0] instanceof BytestringValue)) {
            return this.value[0] as BytestringValue;
        }
    }

    get array() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.every((v: any) => v instanceof IntValue)) {
            return this.value[0].val.map((v: any) => v.val) as number[];
        }
    }

    get arrays() {
        if (this.value.every(v => v instanceof ArrayValue && v.val.every(v => v instanceof IntValue))) {
            return this.value.map(v => v.val.map((v: any) => v.val) as number[]);
        }
    }

    get pHandles() {
        if (this.value.length === 1 && (this.value[0] instanceof ArrayValue) && this.value[0].val.every((v: any) => v instanceof PHandle)) {
            return this.value[0].val as PHandle[];
        }

        if (this.value.every(v => (v instanceof ArrayValue) && v.val.every(p => p instanceof PHandle))) {
            return this.value.flatMap(v => v.val as PHandle[]);
        }
    }

    get pHandleArray() {
        if (this.value.every(v => v instanceof ArrayValue)) {
            return this.value as ArrayValue[];
        }
    }

    get stringArray() {
        if (this.value.every(v => v instanceof StringValue)) {
            return this.value.map(v => v.val) as string[];
        }
    }

    /** Get the entries of the property.
     *  Normally, the entries are split into their own ArrayValues, but they could also be merged to one array value.
     *  I.e., the following is equivalent:
     *  <&gpio0 1 2>, <&gpio0 2 3>
     *  <&gpio0 1 2 &gpio0 2 3>
     *
     *  Both are values with two entries:
     *  [&gpio0, 1, 2], [&gpio0, 2, 3]
     */
    get entries() {
        const val = this.pHandleArray;
        if (!val || !val.length) {
            return;
        }

        const entries = new Array<PHandleEntry>();

        val.forEach(v => {
            let i = 0;
            while (i < v.val.length) {
                const target = v.val[i++];
                if (!(target instanceof PHandle)) {
                    break;
                }

                let count = v.val.slice(i).findIndex(v => v instanceof PHandle);
                if (count === -1) {
                    count = v.val.length - i;
                }
                const cells = v.val.slice(i, i + count);
                if (cells.some(c => !(c instanceof IntValue))) {
                    break;
                }

                entries.push({ target, cells: <(IntValue | Expression)[]>cells });
                i += count;
            }
        });

        return entries;
    }
    get regs() {
        const val = this.pHandleArray;
        if (!val || !val.length) {
            return;
        }

        const entries = new Array<{ addrs: IntValue[], sizes: IntValue[] }>();

        const addrCells = this.node.parent?.addrCells() ?? 2;
        const sizeCells = this.node.parent?.sizeCells() ?? 1;

        val.forEach(v => {
            for (let i = 0; i + addrCells + sizeCells <= v.val.length; i += sizeCells) {
                const addrs = v.val.slice(i, i + addrCells);
                if (!addrs.every(a => a instanceof IntValue)) {
                    break;
                }

                i += addrCells;

                const sizes = v.val.slice(i, i + sizeCells);
                if (!sizes.every(a => a instanceof IntValue)) {
                    break;
                }

                entries.push({ addrs: <IntValue[]>addrs, sizes: <IntValue[]> sizes });
            }
        });

        return entries;
    }

    get nexusMap() {
        if (!this.name.endsWith('-map')) {
            return;
        }

        const val = this.pHandleArray;
        if (!val || !val.length) {
            return [];
        }

        const map = new Array<{ in: IntValue[], target: PHandle, out: IntValue[] }>();

        const targetIdx = val[0].val.findIndex(v => v instanceof PHandle);
        if (targetIdx === -1) {
            return [];
        }

        val.forEach(v => {
            let i = 0;
            while (i + targetIdx + 1 < v.val.length) {
                const inputCells = v.val.slice(i, i + targetIdx);
                if (inputCells.some(c => !(c instanceof IntValue))) {
                    break;
                }

                i += targetIdx;

                const target = v.val[i++];
                if (!(target instanceof PHandle)) {
                    break;
                }

                let outCnt = v.val.slice(i).findIndex(c => !(c instanceof IntValue));
                if (outCnt === -1) {
                    outCnt = v.val.length - i;
                } else {
                    outCnt -= targetIdx; // Accounting for input cells on next entry
                }

                if (outCnt < 0) {
                    break;
                }

                const outputCells = v.val.slice(i, i + outCnt);
                if (outputCells.some(c => c instanceof PHandle)) {
                    break;
                }

                map.push({in: <IntValue[]>inputCells, target: target, out: <IntValue[]>outputCells});
                i += outCnt;
            }
        });

        return map;
    }

    valueNames(): string[] {
        if (!this.name.endsWith('s')) {
            return [];
        }

        return this.node.property(this.name.slice(0, this.name.length - 1) + '-names')?.stringArray ?? [];
    }

    /* Get the expected cellnames for this property. */
    cellNames(ctx: DTSCtx): string[][] {
        const arr = this.pHandleArray;
        if (!arr) {
            return [];
        }

        return this.pHandleArray.map(arr => {
            const contents = arr.val;

            if (this.name === 'reg') {
                const addrCells = this.node.parent?.addrCells() ?? 2;
                const sizeCells = this.node.parent?.sizeCells() ?? 1;
                return [...Array(addrCells).fill('addr'), ...Array(sizeCells).fill('size')];
            }

            if (this.name === 'ranges') {
                const addrCells = this.node.addrCells();
                const parentAddrCells = this.node.parent?.addrCells() ?? 2;
                const sizeCells = this.node.sizeCells();
                return [...Array(addrCells).fill('child-addr'), ...Array(parentAddrCells).fill('parent-addr'), ...Array(sizeCells).fill('size')];
            }

            // Get cells from parents:
            if (this.name.endsWith('s')) {
                const parentName = this.node.parent?.property(this.name.slice(0, this.name.length - 1) + '-parent')?.pHandle?.val;
                if (parentName) {
                    const parent = ctx.node(parentName);
                    const cellCount = parent?.cellCount(this.name);
                    if (cellCount !== undefined) {
                        const cells = new Array(cellCount).fill('cell').map((c, i) => `${c}-${i}`);
                        (<string[]>parent.type?.cells(cellName(this.name)))?.forEach((name, i) => cells[i] = name);
                        return cells;
                    }
                }
            }

            // nexus node:
            if (this.name.endsWith('-map')) {
                const inputCells = contents.findIndex(v => v instanceof PHandle);
                if (inputCells >= 0) {
                    if (this.name === 'interrupt-map') {
                        const interruptSpec = new Array(this.node.property('#interrupt-cells')?.number ?? 0).fill('irq-in');
                        const addrNames = new Array(inputCells - interruptSpec.length).fill('addr-in');
                        const refNode = ctx.node(contents[inputCells]?.val as string);
                        if (refNode) {
                            const outputAddrs = new Array(refNode.addrCells()).fill(`addr-out`);
                            const outputNames = new Array(refNode.property('#interrupt-cells')?.number ?? 0).fill('irq-out');
                            return [...addrNames, ...interruptSpec, '&target', ...outputAddrs, ...outputNames];
                        }

                        return [...addrNames, ...interruptSpec, '&target'];

                    } else {
                        const inputNames = new Array(inputCells).fill('input');
                        this.node.refCellNames(this.name)?.slice(0, inputCells).forEach((c, i) => inputNames[i] = c);
                        const outputNames = ctx.node(contents[inputCells]?.val as string)?.refCellNames(this.name) ?? [];
                        return [...inputNames, '&target', ...outputNames];
                    }
                }
            }

            // Get names from referenced nodes:
            let refCells: any[] = [];
            return contents.map(c => {
                if (c instanceof PHandle) {
                    refCells = Array.from(ctx.node(c.val)?.refCellNames(this.name) ?? [])?.reverse() ?? [];
                    return c.toString();
                }

                if (refCells.length) {
                    return refCells.pop();
                }

                if (contents.length === 1) {
                    return this.name.replace('#', 'Number of ').replace(/-/g, ' ');
                }

                return 'cell';
            });
        });
    }

    valueAt(pos: vscode.Position, uri: vscode.Uri) {
        return this.value.find(v => v.contains(pos, uri));
    }

    type(): string {
        if (this.value.length === 0) {
            return 'invalid';
        }

        if (this.value.length === 1) {
            const v = this.value[0];
            if (v instanceof ArrayValue) {
                if (v.length === 1) {
                    if (v.val[0] instanceof IntValue) {
                        return 'int';
                    }

                    if (v.val[0] instanceof PHandle) {
                        return 'phandle';
                    }

                    return 'invalid';
                }
                if (v.length > 1) {
                    if (v.val.every(e => e instanceof PHandle)) {
                        return 'phandles';
                    }

                    if (v.val.every(e => e instanceof IntValue)) {
                        return 'array';
                    }

                    return 'phandle-array';
                }

                return 'invalid';
            }

            if (v instanceof StringValue) {
                return 'string';
            }

            if (v instanceof BytestringValue) {
                return 'uint8-array';
            }

            if (v instanceof BoolValue) {
                return 'boolean';
            }

            if (v instanceof PHandle) {
                return 'path';
            }

            return 'invalid';
        }

        if (this.value.every(v => v instanceof ArrayValue)) {

            // @ts-ignore:
            if (this.value.every((v: ArrayValue) => v.val.every(e => e instanceof PHandle))) {
                return 'phandles';
            }

            // @ts-ignore:
            if (this.value.every((v: ArrayValue) => v.val.every(e => e instanceof IntValue))) {
                return 'array';
            }

            return 'phandle-array';
        }

        if (this.value.every(v => v instanceof StringValue)) {
            return 'string-array';
        }

        return 'compound';
    }
}

export class NodeEntry {
    node: Node;
    children: NodeEntry[];
    parent?: NodeEntry;
    properties: Property[];
    labels: string[];
    ref?: string;
    loc: vscode.Location;
    nameLoc: vscode.Location;
    file: DTSFile;
    number: number;

    constructor(loc: vscode.Location, node: Node, nameLoc: vscode.Location, ctx: DTSFile, number: number) {
        this.node = node;
        this.children = [];
        this.properties = [];
        this.loc = loc;
        this.nameLoc = nameLoc;
        this.labels = [];
        this.file = ctx;
        this.number = number;
    }

    get root(): any {
        return this.parent?.root ?? this;
    }

    get depth(): number {
        if (!this.parent) {
            return 0;
        }

        return this.parent.depth + 1;
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri) {
        return this.properties.find(p => p.fullRange.contains(pos) && p.loc.uri.toString() === uri.toString());
    }

    contentString(indent = '') {
        let result = '{';
        const innerIndent = indent + '\t';

        const props = this.properties.map(p => innerIndent + p.toString(innerIndent.length) + ';\n').join('');
        if (props) {
            result += '\n' + props;
        }

        const children = this.children.map(c => c.toString(innerIndent) + ';\n').join('');
        if (children) {
            result += '\n' + children;
        }

        return result + indent + '}';
    }

    toString(indent = '') {
        return `${indent}${this.ref ?? this.node.fullName} ${this.contentString(indent)}`;
    }
}

export class Node {
    name: string;
    fullName: string;
    deleted?: vscode.Location;
    parent?: Node;
    path: string;
    address?: number;
    type?: NodeType;
    entries: NodeEntry[];
    pins?: {prop: Property, cells: IntValue[], pinmux?: Node}[];

    constructor(name: string, address?: string, parent?: Node) {
        if (address) {
            this.fullName = name + '@' + address;
        } else {
            this.fullName = name;
        }
        if (address) {
            this.address = parseInt(address, 16);
        }

        if (parent) {
            this.path = parent.path + this.fullName + '/';
        } else if (!name.startsWith('&')) {
            this.path = '/';
            this.fullName = '/';
        } else {
            this.path = this.fullName;
        }

        this.parent = parent;
        this.name = name;
        this.entries = [];
    }

    enabled(): boolean {
        const status = this.property('status');
        return !status?.string || (['okay', 'ok'].includes(status.string));
    }

    hasLabel(label: string) {
        return !!this.entries.find(e => e.labels.indexOf(label) != -1);
    }

    children(): Node[] {
        const children: { [path: string]: Node } = {};
        this.entries.forEach(e => e.children.forEach(c => children[c.node.path] = c.node));
        return Object.values(children);
    }

    get sortedEntries() {
        return this.entries.sort((a, b) => 1000000 * (a.file.priority - b.file.priority) + (a.number - b.number));
    }

    labels(): string[] {
        const labels: string[] = [];
        this.entries.forEach(e => labels.push(...e.labels));
        return labels;
    }

    /** User readable name for this node */
    get uniqueName(): string {
        const labels = this.labels();
        if (labels.length) {
            return '&' + labels[0];
        }

        return this.path;
    }

    /** Local user readable name for this node */
    get localUniqueName(): string {
        const labels = this.labels();
        if (labels.length) {
            return '&' + labels[0];
        }

        return this.fullName;
    }

    get refName(): string {
        const labels = this.labels();
        if (labels.length) {
            return '&' + labels[0];
        }

        return `&{${this.path}}`;
    }

    remap(name: string, entry: PHandleEntry): PHandleEntry {
        const entity = name.slice(0, name.length - 1);
        const map = this.property(entity + '-map');
        if (!map) {
            return;
        }

        const mask = this.property(entity + '-map-mask')?.array ?? [];
        const passThru = this.property(entity + '-map-pass-thru')?.array ?? [];
        const out = map.nexusMap?.find(e => entry.cells.every((c, i) => (c.val & (mask[i] ?? 0xffffffff)) === e.in[i]?.val));
        if (out) {
            return {
                target: out.target,
                cells: out.out.map((c, i) => c.apply(c.val | ((entry.cells[i]?.val ?? 0) & (passThru[i] ?? 0xffffffff))))
            };
        }
    }

    properties(): Property[] {
        const props: Property[] = [];
        this.entries.forEach(e => props.push(...e.properties));
        return props;
    }

    property(name: string): Property | undefined {
        return this.uniqueProperties().find(e => e.name === name);
    }

    addrCells(): number {
        return this.property('#address-cells')?.number ?? 2;
    }

    sizeCells(): number {
        return this.property('#size-cells')?.number ?? 1;
    }

    regs() {
        return this.property('reg')?.regs;
    }

    cellCount(prop: string) {
        return this.property('#' + cellName(prop))?.number ?? 1;
    }

    /** Cell names exposed when the node is referenced */
    refCellNames(prop: string): string[] {
        const typeCellNames = this.type?.cells(cellName(prop));
        if (typeCellNames) {
            return typeCellNames;
        }

        const count = this.property('#' + cellName(prop))?.number;
        if (count === undefined) {
            return;
        }

        return new Array(count).fill(this.name).map((c, i) => `${c}-${i}`);
    }

    uniqueProperties(): Property[] {
        const props: any = {};
        this.sortedEntries.forEach(e => e.properties.forEach((p: any) => props[p.name] = p));
        return Object.values(props);
    }

    toString(expandChildren=false, indent='') {
        let result = indent + this.labels().map(label => `${label}: `).join('') + this.fullName + ' {\n';
        indent += '    ';

        const props = this.uniqueProperties();
        const children = this.children();
        result += props.map(p => indent + p.toString(indent.length) + ';\n').join('');

        if (props.length && children.length) {
            result += '\n';
        }

        if (expandChildren) {
            result += children.filter(c => !c.deleted).map(c => c.toString(expandChildren, indent) + '\n').join('\n');
        } else {
            result += children.map(c => indent + c.fullName + ' { /* ... */ };\n').join('\n');
        }

        return result + indent.slice(4) + '};';
    }
}

export class DTSFile {
    readonly uri: vscode.Uri;
    readonly ctx: DTSCtx;
    processed?: ProcessedFile;
    roots: NodeEntry[];
    entries: NodeEntry[];
    dirty=true;
    priority: number;

    constructor(uri: vscode.Uri, ctx: DTSCtx) {
        this.uri = uri;
        this.ctx = ctx;
        this.priority = ctx.fileCount;
        this.roots = [];
        this.entries = [];
    }

    get defines() {
        return this.processed?.defines ?? {};
    }

    get includes() {
        return this.processed?.includes ?? [];
    }

    get lines() {
        return this.processed?.lines ?? [];
    }

    remove() {
        this.entries.forEach(e => {
            e.node.entries = e.node.entries.filter(nodeEntry => nodeEntry !== e);
        });
        this.entries = [];
        this.dirty = true;
    }

    has(uri: vscode.Uri) {
        return (
            this.uri.toString() === uri.toString() ||
            this.includes.find(include => uri.toString() === include.dst.toString()));
    }

    getNodeAt(pos: vscode.Position, uri: vscode.Uri): Node {
        return this.getEntryAt(pos, uri)?.node;
    }

    getEntryAt(pos: vscode.Position, uri: vscode.Uri): NodeEntry {
        const entries = this.entries.filter(e => e.loc.uri.fsPath === uri.fsPath && e.loc.range.contains(pos));
        if (entries.length === 0) {
            return undefined;
        }

        /* When multiple nodes are matching, they extend each other,
         * and the one with the longest path is the innermost child.
         */
        return entries.sort((a, b) => b.node.path.length - a.node.path.length)[0];
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri): Property {
        return this.getEntryAt(pos, uri)?.getPropertyAt(pos, uri);
    }
}

export class DTSCtx {
    overlays: DTSFile[];
    boardFile: DTSFile;
    parsing?: boolean;
    nodes: {[fullPath: string]: Node};
    dirty: vscode.Uri[];
    includes = new Array<string>();
    _name?: string;
    id: string;
    saved=false;

    constructor() {
        this.nodes = {};
        this.overlays = [];
        this.dirty = [];
    }

    get name() {
        if (this._name) {
            return this._name;
        }

        const uri = this.files.pop()?.uri;
        let folder = path.dirname(uri.fsPath);
        if (path.basename(folder) === 'boards') {
            folder = path.dirname(folder);
        }

        if (vscode.workspace.workspaceFolders?.find(workspace => workspace.uri.fsPath === folder)) {
            return path.basename(uri.fsPath, path.extname(uri.fsPath));
        }

        return vscode.workspace.asRelativePath(folder) + ': ' + path.basename(uri.fsPath, path.extname(uri.fsPath));
    }

    reset() {
        // Kill all affected files:
        if (this.dirty.some(uri => this.boardFile?.has(uri))) {
            this.boardFile.remove();
        }

        this.overlays
            .filter(overlay => this.dirty.some(uri => overlay.has(uri)))
            .forEach(overlay => overlay.remove());

        const removed = { board: this.boardFile, overlays: this.overlays };

        this.boardFile = null;
        this.overlays = [];
        this.nodes = {};
        this.dirty = [];

        return removed;
    }

    insertOverlay(uri: vscode.Uri) {
        this.overlays = [new DTSFile(uri, this), ...this.overlays];
        this.dirty.push(uri);
    }

    adoptNodes(file: DTSFile) {
        file.entries.forEach(e => {
            if (!(e.node.path in this.nodes)) {
                this.nodes[e.node.path] = e.node;
            }
        });
    }

    isValid() {
        return this.dirty.length === 0 && !this.boardFile?.dirty && !this.overlays.some(overlay => !overlay || overlay.dirty);
    }

    node(name: string, parent?: Node): Node | null {
        if (name.startsWith('&{')) {
            const path = name.match(/^&{(.*)}/);
            if (!path) {
                return;
            }

            name = path[1];
        } else if (name.startsWith('&')) {
            const ref = name.slice(1);
            return Object.values(this.nodes).find(n => n.hasLabel(ref)) ?? null;
        }

        if (!name.endsWith('/')) {
            name += '/';
        }

        if (parent) {
            name = parent.path + name;
        }

        return this.nodes[name] ?? null;
    }

    nodeArray() {
        return Object.values(this.nodes);
    }

    has(uri: vscode.Uri): boolean {
        return !!this.boardFile?.has(uri) || this.overlays.some(o => o.has(uri));
    }

    getNodeAt(pos: vscode.Position, uri: vscode.Uri): Node {
        let node: Node;
        this.files.filter(f => f.has(uri)).find(file => node = file.getNodeAt(pos, uri));
        return node;
    }

    getEntryAt(pos: vscode.Position, uri: vscode.Uri): NodeEntry {
        let entry: NodeEntry;
        this.files.filter(f => f.has(uri)).find(file => entry = file.getEntryAt(pos, uri));
        return entry;
    }

    getPropertyAt(pos: vscode.Position, uri: vscode.Uri): Property {
        let prop: Property;
        this.files.filter(f => f.has(uri)).find(file => prop = file.getPropertyAt(pos, uri));
        return prop;
    }

    getReferences(node: Node): PHandle[] {
        const refs = new Array<PHandle>();

        this.properties.forEach((p: any) => {
            refs.push(...(<PHandle[]>p.pHandleArray?.flatMap((v: any) => v.val.filter((v: any) => v instanceof PHandle && v.is(node))) ?? p.pHandles ?? []));
        });

        return refs;
    }

    getProperties(range: vscode.Range, uri: vscode.Uri) {
        const props = new Array<Property>();
        this.nodeArray().forEach(n => {
            props.push(...n.properties().filter(p => p.fullLoc.uri.toString() === uri.toString() && p.fullLoc.range.intersection(range)));
        });

        return props;
    }

    getPHandleNode(handle: number | string): Node {
        if (typeof handle === 'number') {
            return this.nodeArray().find(n => n.properties().find(p => p.name === 'phandle' && p.value[0].val === handle));
        } else if (typeof handle === 'string') {
            return this.nodeArray().find(n => n.labels().find(p => p === handle));
        }
    }

    file(uri: vscode.Uri) {
        return this.files.find(f => f.has(uri));
    }

    get files() {
        if (this.boardFile) {
            return [this.boardFile, ...this.overlays];
        }

        return [...this.overlays];
    }

    get defines() {
        return this.files.map(file => file.processed?.defines).reduce((defines, add) => defines = { ...defines, ...add }, <Defines>{});
    }

    get roots() {
        return this.files.flatMap(c => c?.roots);
    }

    get entries() {
        return this.files.flatMap(c => c?.entries);
    }

    get properties() {
        return this.entries.flatMap(e => e.properties);
    }

    get root() {
        return this.nodes['/'];
    }

    get fileCount() {
        return this.overlays.length + (this.boardFile ? 1 : 0);
    }

    toString() {
        return this.root?.toString(true) ?? '';
    }
}

export class Parser {
    private includes: string[];
    private defines: Defines;
    private appCtx: DTSCtx[];
    private boardCtx: DTSCtx[]; // Raw board contexts, for when the user just opens a .dts or .dtsi file without any overlay
    private types: TypeLoader;
    private changeEmitter: vscode.EventEmitter<DTSCtx>;
    onChange: vscode.Event<DTSCtx>;
    private openEmitter: vscode.EventEmitter<DTSCtx>;
    onOpen: vscode.Event<DTSCtx>;
    private deleteEmitter: vscode.EventEmitter<DTSCtx>;
    onDelete: vscode.Event<DTSCtx>;
    private _currCtx?: DTSCtx;
    private inDTS: boolean;
    private isStable = true;
    private waiters = new Array<() => void>();

    constructor(defines: {[name: string]: string}, includes: string[], types: TypeLoader) {
        this.includes = includes;
        this.defines = {};
        this.types = types;
        this.appCtx = [];
        this.boardCtx = [];
        this.changeEmitter = new vscode.EventEmitter();
        this.onChange = this.changeEmitter.event;
        this.openEmitter = new vscode.EventEmitter();
        this.onOpen = this.openEmitter.event;
        this.deleteEmitter = new vscode.EventEmitter();
        this.onDelete = this.deleteEmitter.event;

        Object.entries(defines).forEach(([name, value]) => this.defines[name] = new Define(name, value));

        // TODO: include paths
        if (vscode.workspace.rootPath != null) {
            this.includes.push(path.join(vscode.workspace.rootPath, "include"));
            this.includes.push(path.join(vscode.workspace.rootPath,
                "scripts",
                "dtc",
                "include-prefixes"));
        }
    }

    file(uri: vscode.Uri) {
        let file = this.currCtx?.file(uri);
        if (file) {
            return file;
        }

        this.contexts.find(ctx => file = ctx.files.find(f => f.has(uri)));
        return file;
    }

    ctx(uri: vscode.Uri): DTSCtx {
        if (this.currCtx?.has(uri)) {
            return this.currCtx;
        }

        return this.contexts.find(ctx => ctx.has(uri));
    }

    set currCtx(ctx: DTSCtx) {
        this._currCtx = ctx;
    }

    get currCtx() {
        if (this.inDTS) {
            return this._currCtx;
        }
    }

    get lastCtx() {
        return this._currCtx;
    }

    async stable(): Promise<void> {
        if (this.isStable) {
            return;
        }

        return new Promise(resolve => this.waiters.push(resolve));
    }

    get contexts() {
        return [...this.appCtx, ...this.boardCtx];
    }

    async addContext(board?: vscode.Uri, overlays=<vscode.Uri[]>[], name?: string): Promise<DTSCtx> {
        const ctx = new DTSCtx();
        let boardDoc: vscode.TextDocument;
        if (board instanceof vscode.Uri) {
            boardDoc = await vscode.workspace.openTextDocument(board).then(doc => doc, _ => undefined);
        } else {
            return;
        }

        if (!boardDoc) {
            return;
        }

        ctx.parsing = true;
        ctx.boardFile = await this.parse(ctx, boardDoc);
        ctx.parsing = false;
        ctx.overlays = (await Promise.all(overlays.map(uri => vscode.workspace.openTextDocument(uri).then(doc => this.parse(ctx, doc), () => undefined)))).filter(d => d);
        if (overlays.length && !ctx.overlays.length) {
            return;
        }

        ctx._name = name;

        /* We want to keep the board contexts rid of .dtsi files if we can, as they're not complete.
         * Remove any .dtsi contexts this board file includes:
         */
        if (path.extname(boardDoc.fileName) === '.dts') {
            this.boardCtx = this.boardCtx.filter(existing => path.extname(existing.boardFile.uri.fsPath) === '.dts' || !ctx.has(existing.boardFile.uri));
        }

        if (overlays.length) {
            this.appCtx.push(ctx);
        } else {
            this.boardCtx.push(ctx);
        }

        this.changeEmitter.fire(ctx);
        return ctx;
    }

    removeCtx(ctx: DTSCtx) {
        this.appCtx = this.appCtx.filter(c => c !== ctx);
        this.boardCtx = this.boardCtx.filter(c => c !== ctx);
        if (this.currCtx === ctx) {
            this._currCtx = null;
        }

        this.deleteEmitter.fire(ctx);
    }

    private async onDidOpen(doc: vscode.TextDocument) {
        if (doc.uri.scheme !== 'file' || doc.languageId !== 'dts') {
            return;
        }

        this.inDTS = true;
        this.currCtx = this.ctx(doc.uri);
        if (this.currCtx) {
            return this.currCtx;
        }

        if (path.extname(doc.fileName) === '.overlay') {
            this.currCtx = await this.addContext(undefined, [doc.uri]);
        } else {
            this.currCtx = await this.addContext(doc.uri, []);
        }

        this.openEmitter.fire(this.currCtx);
        return this.currCtx;
    }

    async insertOverlays(...uris: vscode.Uri[]) {
        if (this.currCtx) {
            uris.forEach(uri => this.currCtx.insertOverlay(uri));
            return this.reparse(this.currCtx);
        }
    }

    /** Reparse after a change.
     *
     * When files change, their URI gets registered in each context.
     * To reparse, we wipe the entries in the changed DTSFiles, and finally wipe the context.
     * This causes the set of nodes referenced in the unchanged files to be free of entries from the
     * changed files. For each file that used to be in the context, we either re-add the nodes it held, or
     * reparse the file (adding any new nodes and their entries). Doing this from the bottom of the
     * file list makes the context look the same as it did the first time when they're parsed.
     */
    private async reparse(ctx: DTSCtx) {
        ctx.parsing = true;
        this.isStable = false;
        const removed = ctx.reset();

        if (removed.board?.dirty) {
            const doc = await vscode.workspace.openTextDocument(removed.board.uri).then(doc => doc, _ => undefined);
            ctx.boardFile = await this.parse(ctx, doc);
        } else {
            ctx.adoptNodes(removed.board);
            ctx.boardFile = removed.board;
        }

        for (const overlay of removed.overlays) {
            if (overlay.dirty) {
                const doc = await vscode.workspace.openTextDocument(overlay.uri).then(doc => doc, _ => undefined);
                ctx.overlays.push(await this.parse(ctx, doc));
            } else {
                ctx.adoptNodes(overlay);
                ctx.overlays.push(overlay);
            }
        }

        ctx.parsing = false;
        this.isStable = true;
        while (this.waiters.length) {
            this.waiters.pop()();
        }

        this.changeEmitter.fire(ctx);
    }

    private onDidChange = async (e: vscode.TextDocumentChangeEvent) => {
        if (!e.contentChanges.length || isTyping(this.onDidChange)) {
            console.log("user is still typing wait");
            return;
        }

        console.log("ok, user stoped to type, now we can parse");

        // Postpone reparsing of other contexts until they're refocused:
        [...this.appCtx, ...this.boardCtx].filter(ctx => ctx.has(e.document.uri)).forEach(ctx => ctx.dirty.push(e.document.uri)); // TODO: Filter duplicates?

        if (this.currCtx && !this.currCtx.parsing) {
            this.reparse(this.currCtx);
        }
    }

    private async onDidChangetextEditor(editor?: vscode.TextEditor) {
        this.inDTS = editor?.document?.languageId === 'dts';
        if (this.inDTS) {
            let uri: vscode.Uri;
            if (editor.document.uri.scheme === 'devicetree') {
                uri = vscode.Uri.file(editor.document.uri.query);
            } else {
                uri = editor.document.uri;
            }

            const ctx = this.ctx(uri);
            if (ctx) {
                this.currCtx = ctx;
                if (ctx.dirty.length) {
                    this.reparse(ctx);
                }
                return;
            }

            if (editor.document.uri.scheme !== 'devicetree') {
                this.currCtx = await this.onDidOpen(editor.document);
            }
        }
    }

    async activate(ctx: vscode.ExtensionContext) {
        // ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => notActive(() => this.onDidOpen(doc))));
        ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument(doc => this.onDidChange(doc)));
        ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => this.onDidChangetextEditor(e)));
        ctx.subscriptions.push(vscode.workspace.onDidDeleteFiles(e => e.files.forEach(uri => {
            const remove = this.contexts.filter(ctx =>
                (ctx.overlays.length === 1 && ctx.overlays[0].uri.toString() === uri.toString()) ||
                (ctx.boardFile?.uri.toString() === uri.toString()));
            remove.forEach(ctx => this.removeCtx(ctx));

            this.contexts.filter(ctx => ctx.has(uri)).forEach(ctx => ctx.dirty.push(uri));
            if (this.currCtx?.dirty.length) {
                this.reparse(this.currCtx);
            }
        })));
        return Promise.all(vscode.window.visibleTextEditors.map(e => this.onDidOpen(e.document)));
    }

    private async parse(ctx: DTSCtx, doc: vscode.TextDocument): Promise<DTSFile> {
        const file = new DTSFile(doc.uri, ctx);
        const processed = await preprocess(doc, {...this.defines, ...ctx.defines}, [...this.includes, ...ctx.includes]);
        const state = new ParserState(doc.uri, processed.lines);

        file.processed = processed;
        let entries = 0;
        const timeStart = process.hrtime();
        const nodeStack: NodeEntry[] = [];
        let requireSemicolon = false;
        let labels = new Array<string>();
        while (state.skipWhitespace()) {
            const blockComment = state.match(/^\/\*[\s\S]*?\*\//);
            if (blockComment) {
                continue;
            }

            const comment = state.match(/^\/\/.*/);
            if (comment) {
                continue;
            }

            if (requireSemicolon) {
                requireSemicolon = false;
                const semicolon = state.match(/^;/);

                continue;
            }

            const label = state.match(/^([\w-]+):\s*/);
            if (label) {
                labels.push(label[1]);
                continue;
            }

            const nameStart = state.freeze();
            const name = state.match(/^([#?\w,.+-]+)/);
            if (name) {
                const addr = state.match(/^@([\da-fA-F]+)/);
                const nameLoc = state.location(nameStart);

                state.skipWhitespace();

                const nodeMatch = state.match(/^{/);
                if (nodeMatch) {
                    let node = new Node(name[1],
                        addr?.[1],
                        nodeStack.length > 0 ? nodeStack[nodeStack.length - 1].node : undefined);

                    if (ctx.nodes[node.path]) {
                        node = ctx.nodes[node.path];
                    } else {
                        ctx.nodes[node.path] = node;
                    }

                    const entry = new NodeEntry(nameLoc, node, nameLoc, file, entries++);

                    entry.labels.push(...labels);
                    node.entries.push(entry);
                    file.entries.push(entry);

                    if (nodeStack.length === 0) {
                        file.roots.push(entry);
                    } else {
                        nodeStack[nodeStack.length - 1].children.push(entry);
                        entry.parent = nodeStack[nodeStack.length - 1];
                    }

                    nodeStack.push(entry);

                    labels = [];
                    continue;
                }

                requireSemicolon = true;

                if (addr) {
                    continue;
                }

                state.skipWhitespace();
                const hasPropValue = state.match(/^=/);
                if (hasPropValue) {
                    if (nodeStack.length > 0) {
                        const p = new Property(name[0], nameLoc, state, nodeStack[nodeStack.length - 1], labels);
                        nodeStack[nodeStack.length - 1].properties.push(p);
                    }

                    labels = [];
                    continue;
                }

                if (nodeStack.length > 0) {
                    const p = new Property(name[0], nameLoc, state, nodeStack[nodeStack.length - 1], labels);
                    nodeStack[nodeStack.length - 1].properties.push(p);
                    labels = [];
                    continue;
                }

                continue;
            }

            const refMatch = state.match(/^(&[\w-]+|&{[\w@/-]+})/);
            if (refMatch) {
                const refLoc = state.location();
                state.skipWhitespace();

                const isNode = state.match(/^{/);
                if (!isNode) {
                    continue;
                }

                let node = ctx.node(refMatch[1]);
                if (!node) {
                    node = new Node(refMatch[1]);
                }

                const entry = new NodeEntry(refLoc, node, refLoc, file, entries++);
                entry.labels.push(...labels);
                node.entries.push(entry);
                entry.ref = refMatch[1];
                if (nodeStack.length === 0) {
                    file.roots.push(entry);
                }

                file.entries.push(entry);
                nodeStack.push(entry);
                labels = [];
                continue;
            }

            if (labels.length) {
                labels = [];
            }

            const versionDirective = state.match(/^\/dts-v.+?\/\s*/);
            if (versionDirective) {
                requireSemicolon = true;
                continue;
            }

            const deleteNode = state.match(/^\/delete-node\//);
            if (deleteNode) {
                state.skipWhitespace();
                requireSemicolon = true;

                const node = state.match(/^&?[\w,.+/@-]+/);
                if (!node) {
                    continue;
                }

                let n: Node;
                if (node[0].startsWith('&') || nodeStack.length === 0) {
                    n = ctx.node(node[0]);
                } else {
                    /* Scope the node search to the current node's children */
                    n = ctx.node(node[0], nodeStack[nodeStack.length - 1].node);
                }
                if (n) {
                    n.deleted = state.location();
                }
                continue;
            }

            const deleteProp = state.match(/^\/delete-property\//);
            if (deleteProp) {
                state.skipWhitespace();
                requireSemicolon = true;

                const prop = state.match(/^[#?\w,._+-]+/);
                if (!prop) {
                    continue;
                }

                if (!nodeStack.length) {
                    continue;
                }

                const props = nodeStack[nodeStack.length-1]?.node.properties();
                if (!props) {
                    continue;
                }
                const p = props.find(p => p.name === deleteProp[0]);
                if (!p) {
                    continue;
                }

                continue;
            }

            const rootMatch = state.match(/^\/\s*{/);
            if (rootMatch) {
                if (!ctx.root) {
                    ctx.nodes['/'] = new Node('');
                }
                const entry = new NodeEntry(state.location(), ctx.root, new vscode.Location(state.location().uri, state.location().range.start), file, entries++);
                ctx.root.entries.push(entry);
                file.roots.push(entry);
                file.entries.push(entry);
                nodeStack.push(entry);
                continue;
            }

            const closingBrace = state.match(/^}/);
            if (closingBrace) {
                if (nodeStack.length > 0) {
                    const entry = nodeStack.pop();
                    entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, state.location().range.end));
                }

                requireSemicolon = true;
                continue;
            }

            state.skipToken();
        }

        if (nodeStack.length > 0) {
            const loc = state.location();
            const entry = nodeStack[nodeStack.length - 1];
            entry.loc = new vscode.Location(entry.loc.uri, new vscode.Range(entry.loc.range.start, state.location().range.end));
            console.error(`Unterminated node: ${nodeStack[nodeStack.length - 1].node.name}`);
        }

        const procTime = process.hrtime(timeStart);

        console.log(`Parsed ${doc.uri.fsPath} in ${(procTime[0] * 1e9 + procTime[1]) / 1000000} ms`);
        console.log(`Nodes: ${Object.keys(ctx.nodes).length} entries: ${Object.values(ctx.nodes).reduce((sum, n) => sum + n.entries.length, 0)}`);

        // Resolve types:
        let time = process.hrtime();
        Object.values(ctx.nodes).forEach(node => {
            if (!node.type?.valid) {
                node.type = this.types.nodeType(node);
            }
        });
        time = process.hrtime(time);
        console.log(`Resolved types for ${file.uri.fsPath} in ${(time[0] * 1e9 + time[1]) / 1000000} ms`);
        return file;
    }
}

export function getCells(propName: string, parent?: Node): string[] | undefined {
    const cellProp = getPHandleCells(propName, parent);

    if (cellProp) {
        return ['label'].concat(Array(<number> cellProp.value[0].val).fill('cell'));
    }

    if (propName === 'reg') {
        const addrCells = parent?.addrCells() ?? 2;
        const sizeCells = parent?.sizeCells() ?? 1;
        return [...Array(addrCells).fill('addr'), ...Array(sizeCells).fill('size')];
    }
}

export function cellName(propname: string) {
    if (propname.endsWith('s')) {
        /* Weird rule: phandle array cell count is determined by the #XXX-cells entry in the parent,
         * where XXX is the singular version of the name of this property UNLESS the property is called XXX-gpios, in which
         * case the cell count is determined by the parent's #gpio-cells property
         */
        return propname.endsWith('-gpios') ? 'gpio-cells' : propname.slice(0, propname.length - 1) + '-cells';
    }

    if (propname.endsWith('-map')) {
        return propname.slice(0, propname.length - '-map'.length) + '-cells';
    }

    if (propname === 'interrupts-extended') {
        return 'interrupt-cells';
    }
}

export function getPHandleCells(propname: string, parent: Node): Property {
    return parent?.property('#' + cellName(propname));
}
