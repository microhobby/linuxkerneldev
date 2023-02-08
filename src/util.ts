import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('CTags');
const __DEBUG__ = false;

export function log(...args: any[]) {
  if (__DEBUG__) {
    args.unshift('vscode-ctags:');
    console.log(...args);
    channel.appendLine(args.join(' '));
  }
}

var _timeTypingRef: NodeJS.Timeout;
var _isTyping = false;
var _callBackShow: (e: vscode.TextDocumentChangeEvent) => void;
const _typeDelay = 1000;

vscode.workspace.onDidChangeTextDocument(ev => {
  _isTyping = true;
  
  clearTimeout(_timeTypingRef);
  
  _timeTypingRef = setTimeout(() => {
    _isTyping = false;

    if (_callBackShow != null) {
      _callBackShow(ev);
    }
  
  }, _typeDelay);
});

export function isTyping (call: (e: vscode.TextDocumentChangeEvent) => void): boolean {
  _callBackShow = call;
  return _isTyping;
}

export async function delay (miliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, miliseconds);
  });
}
