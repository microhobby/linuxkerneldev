// ****************************************************************************
// ****************************************************************************
// ****************************************************************************
'use strict';
import * as path from 'path';
import * as vscode from 'vscode';
import * as ctags from './ctags';
import * as util from './util';
// non ctags related
import { LinuxDevCmdProvider, CmdOption } from './cmdNodeProvider'
import { LinuxNativeCommands } from './LinuxNativeCommands';

const tagsfile = '.vscode-ctags';
let tags: ctags.CTags;

class CTagsDefinitionProvider implements vscode.DefinitionProvider {
	public provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.Definition> {
		const query = document.getText(
			document.getWordRangeAtPosition(position));
		return this.resolveDefinitions(query);
	}

	private async resolveDefinitions(query: string): Promise<vscode.Definition> {
		const matches = await tags.lookup(query);
		if (!matches) {
			util.log(`"${query}" has no matches.`);
			return [];
		}
		return matches.map(match => {
			util.log(`"${query}" matches ${match.path}:${match.lineno}`);
			return new vscode.Location(
				vscode.Uri.file(match.path),
				new vscode.Position(match.lineno, 0)
			);
		});
	}
}

class CTagsHoverProvider implements vscode.HoverProvider {
	public provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.Hover> {
		const query = document.getText(
			document.getWordRangeAtPosition(position));
		return this.resolveHover(query);
	}

	private async resolveHover(query: string): Promise<vscode.Hover | null> {
		const matches = await tags.lookup(query);
		if (!matches) {
			util.log(`"${query}" has no matches.`);
			return null;
		}
		util.log(`"${query}" has ${matches.length} matches.`);
		const summary = matches.map(match => {
			return (
				path.relative(vscode.workspace.rootPath || '', match.path) +
				':' +
				match.lineno
			);
		});
		return new vscode.Hover(new vscode.MarkdownString(
						summary.join('  \n')));
	}
}

class CTagsCompletionProvider implements vscode.CompletionItemProvider {
	public provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext
	): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
		const prefix = document
			.getText(document.getWordRangeAtPosition(position));
		return this.resolveCompletion(prefix);
	}

	private async resolveCompletion(
		prefix: string
	): Promise<vscode.CompletionItem[] | null> {
		const matches = await tags.lookupCompletions(prefix);
		if (!matches) {
			util.log(`"${prefix}" has no matches.`);
			return null;
		}
		util.log(`"${prefix}" has ${matches.length} matches.`);
		return matches.map(match => {
			return new vscode.CompletionItem(match.name);
		});
	}
}

function regenerateArgs(): string[] {
	const config = vscode.workspace.getConfiguration('ctags');
	const excludes = config
		.get<string[]>('excludePatterns', [])
		.map((pattern: string) => {
			return '--exclude=' + pattern;
		})
		.join(' ');
	const languages =
		'--languages=' + config.get<string[]>('languages', ['all'])
			.join(',');
	return [languages, excludes];
}

function regenerateCTags() {
	const args = regenerateArgs();
	const title =
		args && args.length
			? `Generating CTags index (${args.join(' ')})`
			: 'Generating CTags index';
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Window,
			title
		},
		(progress, token) => {
			return tags.regenerate(regenerateArgs()).catch(err => {
				vscode.window.setStatusBarMessage(
					'Generating CTags failed: ' + err);
			});
		}
	);
}

export function activate(context: vscode.ExtensionContext) {
	util.log('extension activated.');

	// time to work
	// tree view
	const cmdNodesProvider =
		new LinuxDevCmdProvider(vscode.workspace.rootPath);
	vscode.window.registerTreeDataProvider('linuxDevCmdView',
		cmdNodesProvider);

	// scripts wrapper
	const nativeCmdsExecuter = new LinuxNativeCommands();

	// check for deps
	nativeCmdsExecuter.checkDeps(vscode.workspace.rootPath,
		(data: string) => {
			vscode.window.setStatusBarMessage(data);
		}, (err: string) => {
			vscode.window.showErrorMessage(`${err} \n \
				please: apt-get install universal-ctags`);
		}
	);

	function getSelectedString(): string {
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

	function getSelectedInclude(): string {
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

	// ctags
	tags = new ctags.CTags(vscode.workspace.rootPath || '', tagsfile);
	tags
		.reindex()
		.then(() => {
			vscode.window.setStatusBarMessage('CTags index loaded',
					2000);
		})
		.catch(() => {
			return regenerateCTags();
		});

	const definitionsProvider = new CTagsDefinitionProvider();
	vscode.languages.registerDefinitionProvider(
		{ scheme: 'file', language: 'cpp' },
		definitionsProvider
	);
	vscode.languages.registerDefinitionProvider(
		{ scheme: 'file', language: 'c' },
		definitionsProvider
	);
	vscode.languages.registerDefinitionProvider(
		{ scheme: 'file', language: 'dts' },
		definitionsProvider
	);
	vscode.languages.registerDefinitionProvider(
		{ scheme: 'file', language: 'dtsi' },
		definitionsProvider
	);
	vscode.languages.registerDefinitionProvider(
		{ scheme: 'file', language: 'kconfig' },
		definitionsProvider
	);
	vscode.languages.registerDefinitionProvider(
		{ scheme: 'file', language: 'makefile' },
		definitionsProvider
	);

	const hoverProvider = new CTagsHoverProvider();
	vscode.languages.registerHoverProvider(
		{ scheme: 'file', language: 'c' },
		hoverProvider
	);
	vscode.languages.registerHoverProvider(
		{ scheme: 'file', language: 'cpp' },
		hoverProvider
	);
	vscode.languages.registerHoverProvider(
		{ scheme: 'file', language: 'dts' },
		hoverProvider
	);
	vscode.languages.registerHoverProvider(
		{ scheme: 'file', language: 'dtsi' },
		hoverProvider
	);
	vscode.languages.registerHoverProvider(
		{ scheme: 'file', language: 'kconfig' },
		hoverProvider
	);
	vscode.languages.registerHoverProvider(
		{ scheme: 'file', language: 'makefile' },
		hoverProvider
	);

	const completionProvider = new CTagsCompletionProvider();
	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: 'c' },
		completionProvider
	);
	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: 'cpp' },
		completionProvider
	);
	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: 'dts' },
		completionProvider
	);
	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: 'dtsi' },
		completionProvider
	);
	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: 'kconfig' },
		completionProvider
	);
	vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: 'makefile' },
		completionProvider
	);

	const regenerateCTagsCommand = vscode.commands.registerCommand(
		'embeddedLinuxDev.regenerateCTags',
		() => {
			regenerateCTags();
		}
	);

	// tree
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

	//context.subscriptions.push(disposable);
	// tree

	context.subscriptions.push(regenerateCTagsCommand);

	vscode.workspace.onDidSaveTextDocument(event => {
		util.log('saved', event.fileName, event.languageId);
		const config = vscode.workspace.getConfiguration('ctags');
		const autoRegenerate = config.get<boolean>('regenerateOnSave');
		if (autoRegenerate) {
			regenerateCTags();
		}
	});
}

export function deactivate() { }
