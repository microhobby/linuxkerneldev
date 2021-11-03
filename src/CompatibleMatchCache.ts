import * as vscode from 'vscode';

export type MatchCache = {
    compatible: string
    file: vscode.Uri
};

export type DocMatchCache = {
    compatible: string,
    files: vscode.Uri[]
};

export class CompatibleMatchCache {
    static Cache: MatchCache[] = [];
    static DocCache: DocMatchCache[] = [];
};
