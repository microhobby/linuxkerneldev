import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('CTags');

export function log(...args: any[]) {
  args.unshift('vscode-ctags:');
  console.log(...args);
  channel.appendLine(args.join(' '));
}
