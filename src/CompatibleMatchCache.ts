import * as vscode from 'vscode';

export type MatchCache = {
    compatible: string
    file: vscode.Uri,
    notFound: boolean
};

export type DocMatchCache = {
    compatible: string,
    files: vscode.Uri[],
    notFound: boolean
};

export class CompatibleMatchCache {
    static Cache: MatchCache[] = [];
    static DocCache: DocMatchCache[] = [];
};
