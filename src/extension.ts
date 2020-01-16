// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { LinuxDevCmdProvider, CmdOption } from './cmdNodeProvider'
import { LinuxNativeCommands } from './LinuxNativeCommands';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "linuxkerneldev" is now active!');

	// tree view
	const cmdNodesProvider =
		new LinuxDevCmdProvider(vscode.workspace.rootPath);
	vscode.window.registerTreeDataProvider('linuxDevCmdView',
						cmdNodesProvider);
	
	// scripts wrapper
	const nativeCmdsExecuter = new LinuxNativeCommands();

	/*function getSelectedString(): string
	{
		const editor = vscode.window.activeTextEditor;

		if (editor != undefined) {
			let start = editor.selection.start;
			let end = editor.selection.end;
			let highlight = editor.document.getText(
				new vscode.Range(start, end));

			return highlight;
		}

		return "";
	}*/

	function getSelectedString(): string
	{
		const editor = vscode.window.activeTextEditor;

		if (editor != undefined) {
			let start: vscode.Position = editor.selection.start;
			let yeap = true;
			let line = start.line;
			let cstart = start.character;
			let cend = cstart;
			let auxStart = 0;
			let auxEnd = 0;

			// get start
			while (yeap) {
				cstart--;
				let char = editor.document.getText(
					new vscode.Range(line, cstart, line, cend));

				if (char == "\"") {
					yeap = false;
				} else if (cstart == 0) {
					return "";
				}
				cend--;
			}
			auxStart = cstart;
			
			cstart = start.character;
			cend = cstart;
			yeap = true;

			// get end
			while (yeap) {
				cstart++;
				let char = editor.document.getText(
					new vscode.Range(line, cstart, line, cend));

				if (char == "\"") {
					yeap = false;
				} else if (char == "") {
					return "";
				}
				cend++;
			}
			auxEnd = cstart;

			let highlight = editor.document.getText(
				new vscode.Range(line, auxStart, line, auxEnd));

			return highlight.replace("\"", "").replace("\"", "");
		}

		return "";
	}

	function getSelectedInclude(): string
	{
		const editor = vscode.window.activeTextEditor;

		if (editor != undefined) {
			let start: vscode.Position = editor.selection.start;
			let yeap = true;
			let line = start.line;
			let cstart = start.character;
			let cend = cstart;
			let auxStart = 0;
			let auxEnd = 0;

			// get start
			while (yeap) {
				cstart--;
				let char = editor.document.getText(
					new vscode.Range(line, cstart, line, cend));

				if (char == "<") {
					yeap = false;
				} else if (cstart == 0) {
					return "";
				}
				cend--;
			}
			auxStart = cstart;
			
			cstart = start.character;
			cend = cstart;
			yeap = true;

			// get end
			while (yeap) {
				cstart++;
				let char = editor.document.getText(
					new vscode.Range(line, cstart, line, cend));

				if (char == ">") {
					yeap = false;
				} else if (char == "") {
					return "";
				}
				cend++;
			}
			auxEnd = cstart;

			let highlight = editor.document.getText(
				new vscode.Range(line, auxStart, line, auxEnd));

			return highlight.replace("<", "").replace(">", "");
		}

		return "";
	}

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('embeddedLinuxDev.helloWorld', () => {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World!');
	});

	// here begins the real code
	vscode.commands.registerCommand(
		'embeddedLinuxDev.findAndOpenDeviceTreeDoc', () => {
	
		console.log("bosta");

		// call the grep script
		nativeCmdsExecuter.findAndOpenDeviceTreeDoc(
			getSelectedString(),
			vscode.workspace.rootPath,
			(data: string) => {
				vscode.window.setStatusBarMessage(data);
			},
			(err: string) => {
				vscode.window.showErrorMessage(err);
			});
	});

	vscode.commands.registerCommand(
		'embeddedLinuxDev.findAndOpenDeviceTreeMatchDriver', () => {
		// call the grep script
		nativeCmdsExecuter.findDeviceTreeMatch(
			getSelectedString(),
			vscode.workspace.rootPath,
			(data: string) => {
				vscode.window.setStatusBarMessage(data);
			},
			(err: string) => {
				vscode.window.showErrorMessage(err);
			});
	});

	vscode.commands.registerCommand(
		'embeddedLinuxDev.openArmDtsDtsi', () => {
		// call the grep script
		nativeCmdsExecuter.findArmDts(
			getSelectedString(),
			vscode.workspace.rootPath,
			(data: string) => {
				vscode.window.setStatusBarMessage(data);
			},
			(err: string) => {
				vscode.window.showErrorMessage(err);
			});
	});

	vscode.commands.registerCommand(
		'embeddedLinuxDev.openArm64DtsDtsi', () => {
		// call the grep script
		nativeCmdsExecuter.findArm64Dts(
			getSelectedString(),
			vscode.workspace.rootPath,
			(data: string) => {
				vscode.window.setStatusBarMessage(data);
			},
			(err: string) => {
				vscode.window.showErrorMessage(err);
			});
	});

	vscode.commands.registerCommand(
		'embeddedLinuxDev.openLinuxInclude', () => {
		// call the grep script
		nativeCmdsExecuter.findLinuxInclude(
			getSelectedInclude(),
			vscode.workspace.rootPath,
			(data: string) => {
				vscode.window.setStatusBarMessage(data);
			},
			(err: string) => {
				vscode.window.showErrorMessage(err);
			});
	});

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
