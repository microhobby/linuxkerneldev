/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import { Line } from './preprocessor';

type Offset = { line: number, col: number };

export class ParserState {
    readonly token = /^[#-\w]+|./;
    readonly lines: Line[];
    private offset: Offset;
    private prevRange: { start: Offset, length: number };
    uri: vscode.Uri;

    location(start?: Offset, end?: Offset) {
        if (!start) {
            start = this.prevRange.start;
        }

        if (!end) {
            end = <Offset>{ line: this.prevRange.start.line, col: this.prevRange.start.col + this.prevRange.length };
        }

        const startLine = this.lines[start.line];
        const endLine = this.lines[end.line];

        return new vscode.Location(startLine.uri,
                                   new vscode.Range(startLine.number, startLine.rawPos(start.col, true),
                                                    endLine.number, endLine.rawPos(end.col, false)));
    }

    getLine(uri: vscode.Uri, pos: vscode.Position) {
        return this.lines.find(l => l.contains(uri, pos));
    }

    raw(loc: vscode.Location) {
        if (loc.range.isSingleLine) {
            return this.getLine(loc.uri, loc.range.start)?.raw.slice(loc.range.start.character, loc.range.end.character) ?? '';
        }

        let i = this.lines.findIndex(l => l.contains(loc.uri, loc.range.start));
        if (i < 0) {
            return '';
        }

        let content = this.lines[i].raw.slice(loc.range.start.character);
        while (!this.lines[++i].contains(loc.uri, loc.range.end)) {
            content += this.lines[i].raw;
        }

        content += this.lines[i].raw.slice(0, loc.range.end.character);
        return content;
    }

    match(pattern?: RegExp): RegExpMatchArray | undefined {
        const match = this.peek(pattern ?? this.token);
        if (match) {
            this.prevRange.start = { ...this.offset };
            this.prevRange.length = match[0].length;

            this.offset.col += match[0].length;
            if (this.offset.col === this.lines[this.offset.line].length) {
                this.offset.col = 0;
                this.offset.line++;
            }
        }

        return match;
    }

    eof(): boolean {
        return this.offset.line === this.lines.length;
    }

    get next(): string {
        return this.lines[this.offset.line].text.slice(this.offset.col);
    }

    skipWhitespace() {
        const prevRange = { ...this.prevRange };

        while (this.match(/^\s+/));

        /* Ignore whitespace in diagnostics ranges */
        this.prevRange = prevRange;
        return !this.eof();
    }

    skipToken() {
        const match = this.match(this.token);
        if (!match) {
            this.offset.line = this.lines.length;
            return '';
        }

        return match[0];
    }

    reset(offset: Offset) {
        this.offset = offset;
    }

    peek(pattern?: RegExp) {
        if (this.offset.line >= this.lines.length) {
            return undefined;
        }

        return this.next.match(pattern ?? this.token);
    }

    peekLocation(pattern?: RegExp): vscode.Location {
        const match = this.peek(pattern ?? this.token);
        if (!match) {
            return undefined;
        }

        const prev = this.location();
        return new vscode.Location(prev.uri, new vscode.Range(prev.range.end, new vscode.Position(prev.range.end.line, prev.range.end.character + match[0].length)));
    }

    freeze(): Offset {
        return { ...this.offset };
    }

    since(start: Offset) {
        return this.lines.slice(start.line, this.offset.line + 1).map((l, i) => {
            if (i === this.offset.line - start.line) {
                if (i === 0) {
                    return l.text.slice(start.col, this.offset.col);
                }

                return l.text.slice(0, this.offset.col);
            }

            if (i === 0) {
                return l.text.slice(start.col);
            }

            return l.text;
        }).join('\n');
    }

    constructor(uri: vscode.Uri, lines: Line[]) {
        this.uri = uri;
        this.offset = {line: 0, col: 0};
        this.prevRange = { start: this.offset, length: 0 };
        this.lines = lines;
    }
}
