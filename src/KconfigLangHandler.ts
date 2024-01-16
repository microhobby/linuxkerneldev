/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as fuzzy from "fuzzysort";
import { Operator } from './evaluate';
import { Config, ConfigOverride, ConfigEntry, Repository, IfScope, Scope, Comment } from "./kconfig";
import * as kEnv from './env';
import { PropFile } from './propfile';
import * as fs from 'fs';
import * as path from 'path';
import { ExtensionUtils } from './Utils/ExtensionsUtils';

export class KconfigLangHandler
	implements
		vscode.DefinitionProvider,
		vscode.HoverProvider,
		vscode.CompletionItemProvider,
		vscode.DocumentLinkProvider,
		vscode.ReferenceProvider,
		vscode.CodeActionProvider,
		vscode.DocumentSymbolProvider,
		vscode.WorkspaceSymbolProvider {
	diags: vscode.DiagnosticCollection;
	fileDiags: {[uri: string]: vscode.Diagnostic[]};
	propFiles: { [uri: string]: PropFile };
	rootCompletions: vscode.CompletionItem[];
	propertyCompletions: vscode.CompletionItem[];
	repo: Repository;
	conf: ConfigOverride[];
	temporaryRoot: string | null;
	rootChangeIgnore = new Array<string>();
	rescanTimer?: NodeJS.Timeout;
	constructor() {
		const sortItems = (item: vscode.CompletionItem, i: number) => {
			const pad = '0000';
			item.sortText = `root-${pad.slice(i.toString().length)}${i.toString()}`;
			return item;
		};
		this.rootCompletions = [
			new vscode.CompletionItem('config', vscode.CompletionItemKind.Class),
			new vscode.CompletionItem('menuconfig', vscode.CompletionItemKind.Class),
			new vscode.CompletionItem('choice', vscode.CompletionItemKind.Class),
			new vscode.CompletionItem('endchoice', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('if', vscode.CompletionItemKind.Module),
			new vscode.CompletionItem('endif', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('menu', vscode.CompletionItemKind.Module),
			new vscode.CompletionItem('endmenu', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('source', vscode.CompletionItemKind.File),
			new vscode.CompletionItem('rsource', vscode.CompletionItemKind.File),
			new vscode.CompletionItem('osource', vscode.CompletionItemKind.File),
		].map(sortItems);

		this.propertyCompletions = [
			new vscode.CompletionItem('bool', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('int', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('hex', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('tristate', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('string', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('def_bool', vscode.CompletionItemKind.Variable),
			new vscode.CompletionItem('def_int', vscode.CompletionItemKind.Variable),
			new vscode.CompletionItem('def_hex', vscode.CompletionItemKind.Variable),
			new vscode.CompletionItem('def_tristate', vscode.CompletionItemKind.Variable),
			new vscode.CompletionItem('def_string', vscode.CompletionItemKind.Variable),
			new vscode.CompletionItem('optional', vscode.CompletionItemKind.Property),
			new vscode.CompletionItem('depends on', vscode.CompletionItemKind.Reference),
			new vscode.CompletionItem('visible if', vscode.CompletionItemKind.Property),
			new vscode.CompletionItem('default', vscode.CompletionItemKind.Property),
		];

		var range = new vscode.CompletionItem('range', vscode.CompletionItemKind.Keyword);
		range.insertText = new vscode.SnippetString('range ');
		range.insertText.appendPlaceholder('min');
		range.insertText.appendText(' ');
		range.insertText.appendPlaceholder('max');
		this.propertyCompletions.push(range);

		var help = new vscode.CompletionItem('help', vscode.CompletionItemKind.Keyword);
		help.insertText = new vscode.SnippetString('help\n  ');
		help.insertText.appendTabstop();
		help.commitCharacters = [' ', '\t', '\n'];
		this.propertyCompletions.push(help);

		this.propertyCompletions = this.propertyCompletions.map(sortItems);

		this.fileDiags = {};
		this.propFiles = {};
		this.temporaryRoot = null;
		this.diags = vscode.languages.createDiagnosticCollection('kconfig');
		this.repo = new Repository(this.diags);
		this.conf = [];
	}

	private setKconfigLang(d: vscode.TextDocument) {
		if ((!d.languageId || d.languageId === 'plaintext') && path.basename(d.fileName).startsWith('Kconfig.')) {
			vscode.languages.setTextDocumentLanguage(d, 'kconfig');
		}
	}

	private suggestKconfigRoot(propFile: PropFile) {
		// hint at Kconfig root file
		let kconfigRoot;

		if (fs.existsSync(path.resolve(path.dirname(propFile.uri.fsPath), 'Kconfig'))) {
			kconfigRoot = path.resolve(path.dirname(propFile.uri.fsPath), 'Kconfig');
		} else {
			// buildroot edge case
			kconfigRoot = path.resolve(path.dirname(propFile.uri.fsPath), 'Config.in');
		}

		if (!this.rootChangeIgnore.includes(kconfigRoot) && kconfigRoot !== this.repo.root?.uri.fsPath && fs.existsSync(kconfigRoot)) {
			vscode.window.showInformationMessage(`A Kconfig file exists in this directory.\nChange the Kconfig root file?`, 'Temporarily', 'Permanently', 'Never').then(t => {
				if (t === 'Temporarily') {
					this.repo.setRoot(vscode.Uri.file(kconfigRoot));
					this.rescan();
					this.temporaryRoot = propFile.uri.fsPath;
				} else if (t === 'Permanently') {
					this.repo.setRoot(vscode.Uri.file(kconfigRoot));
					kEnv.setConfig('root', kconfigRoot);
				} else if (t === 'Never') {
					this.rootChangeIgnore.push(kconfigRoot);
				}
			});
		}
	}

	registerHandlers(context: vscode.ExtensionContext) {
		var disposable: vscode.Disposable;

		disposable = vscode.workspace.onDidChangeTextDocument(async e => {
			if (e.document.languageId === 'kconfig') {
				this.repo.onDidChange(e.document.uri, e);
			} else if (e.document.languageId === 'defconfig' && e.contentChanges.length > 0) {
				var file = this.propFile(e.document.uri);
				file.onChange(e);
			}
		});
		context.subscriptions.push(disposable);

		// Watch changes to files that aren't opened in vscode.
		// Handles git checkouts and similar out-of-editor events
		var watcher = vscode.workspace.createFileSystemWatcher('**/Kconfig*', true, false, true);
		watcher.onDidChange(uri => {
			if (!vscode.workspace.textDocuments.some(d => d.uri.fsPath === uri.fsPath)) {
				this.delayedRescan();
			}
		});
		context.subscriptions.push(watcher);

		disposable = vscode.window.onDidChangeActiveTextEditor(e => {
			if (e?.document.languageId === 'defconfig') {
				var file;
				if (this.temporaryRoot && this.temporaryRoot !== e.document.uri.fsPath) {
					this.temporaryRoot = null;
					this.repo.setRoot(kEnv.getRootFile());
					this.rescan();
					file = this.propFile(e.document.uri);
				} else {
					file = this.propFile(e.document.uri);
					file.reparse(e.document);
				}

				this.suggestKconfigRoot(file);
			} else if (e?.document) {
				this.setKconfigLang(e.document);
			}
		});
		context.subscriptions.push(disposable);

		disposable = vscode.workspace.onDidSaveTextDocument(d => {
			if (d.languageId === 'defconfig') {
				var file = this.propFile(d.uri);
				file.onSave(d);
			}
		});
		context.subscriptions.push(disposable);

		disposable = vscode.workspace.onDidOpenTextDocument(d => {
			if (d.languageId === 'defconfig') {
				var file;
				if (this.temporaryRoot && this.temporaryRoot !== d.uri.fsPath) {
					this.temporaryRoot = null;
					this.repo.setRoot(kEnv.getRootFile());
					this.rescan();
					file = this.propFile(d.uri);
				} else {
					file = this.propFile(d.uri);
					file.onOpen(d);
				}

				this.suggestKconfigRoot(file);
			} else {
				this.setKconfigLang(d);
			}
		});
		context.subscriptions.push(disposable);

		disposable = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('kconfig')) {
				kEnv.update();
				if (e.affectsConfiguration('kconfig.root')) {
					this.repo.setRoot(kEnv.getRootFile());
				}
				this.rescan();
			}
		});
		context.subscriptions.push(disposable);

		const kconfig = [{ language: 'kconfig', scheme: 'file' }, { language: 'kconfig', scheme: 'kconfig' }];
		const properties = [{ language: 'defconfig', scheme: 'file' }];
		const cFiles = [
			{ language: 'c', scheme: 'file' },
			{ language: 'makefile', scheme: 'file' }
		];
		const all = [...kconfig, ...properties, ...cFiles];

		disposable = vscode.languages.registerDefinitionProvider(all, this);
		context.subscriptions.push(disposable);
		disposable = vscode.languages.registerHoverProvider(all, this);
		context.subscriptions.push(disposable);
		disposable = vscode.languages.registerCompletionItemProvider(all, this);
		context.subscriptions.push(disposable);
		disposable = vscode.languages.registerDocumentLinkProvider(kconfig, this);
		context.subscriptions.push(disposable);
		disposable = vscode.languages.registerCodeActionsProvider(properties, this);
		context.subscriptions.push(disposable);
		disposable = vscode.languages.registerDocumentSymbolProvider([...kconfig, ...properties], this);
		context.subscriptions.push(disposable);
		disposable = vscode.languages.registerWorkspaceSymbolProvider(this);
		context.subscriptions.push(disposable);
		disposable = vscode.languages.registerReferenceProvider(kconfig, this);
		context.subscriptions.push(disposable);

		this.repo.activate(context);
	}

	propFile(uri: vscode.Uri): PropFile {
		if (!(uri.fsPath in this.propFiles)) {
			this.propFiles[uri.fsPath] = new PropFile(uri, this.repo, this.conf, this.diags);
		}

		return this.propFiles[uri.fsPath];
	}

	delayedRescan(delay=1000) {
		// debounce:
		if (this.rescanTimer) {
			clearTimeout(this.rescanTimer);
		}

		this.rescanTimer = setTimeout(() => {
			this.rescan();
		}, delay);
	}

	async rescan() {
		console.log('Kconfig: Rescan');
		this.propFiles = {};
		this.diags.clear();
		this.repo.reset();

		return await this.doScan();
	}

	refreshOpenPropfiles() {
		vscode.window.visibleTextEditors
			.filter(e => e.document.languageId === 'defconfig')
			.forEach(e => this.propFile(e.document.uri).reparse(e.document));
	}

	async activate(context: vscode.ExtensionContext) {
		var root = kEnv.getRootFile();
		if (!root) {
			return;
		}

		vscode.workspace.textDocuments.forEach(d => {
			this.setKconfigLang(d);
		});
		this.registerHandlers(context);
		this.repo.setRoot(root);
		await this.doScan();

		if (vscode.window.activeTextEditor?.document.languageId === 'defconfig') {
			this.suggestKconfigRoot(this.propFile(vscode.window.activeTextEditor.document.uri));
		}
	}

	deactivate() {
		this.propFiles = {};
		this.diags.clear();
		this.repo.reset();
	}

	private async doScan() {
		ExtensionUtils.showStatusBarLoading('Kconfig: Scanning...');
		var hrTime = process.hrtime();

		// make sure to parse the environment variables before parsing
		kEnv.update();
		await this.repo.parse();

		hrTime = process.hrtime(hrTime);

		this.conf = this.loadConfOptions();

		this.refreshOpenPropfiles();

		var time_ms = Math.round(hrTime[0] * 1000 + hrTime[1] / 1000000);
		ExtensionUtils.hideStatusBarLoading();
		ExtensionUtils.showStatusBarOk(`Kconfig: ${Object.keys(this.repo.configs).length} entries, ${time_ms} ms`);
	}

	loadConfOptions(): ConfigOverride[] {
		var conf: { [config: string]: string | boolean | number } = kEnv.getConfig('conf');
		var entries: ConfigOverride[] = [];
		Object.keys(conf).forEach(c => {
			var e = this.repo.configs[c];
			if (e) {
				var value;
				if (value === true) {
					value = 'y';
				} else if (value === false) {
					value = 'n';
				} else {
					value = conf[c].toString();
				}
				entries.push({ config: e, value: value });
			}
		});

		var conf_files: string[] = kEnv.getConfig('conf_files');

		if (conf_files) {
			conf_files.forEach(f => {
				try {
					var text = kEnv.readFile(vscode.Uri.file(kEnv.pathReplace(f)));
				} catch (e) {
					if (e instanceof Error) {
						if ('code' in e && e['code'] === 'ENOENT') {
							vscode.window.showWarningMessage(`File "${f}" not found`);
						} else {
							vscode.window.showWarningMessage(`Error while reading conf file ${f}: ${e.message}`);
						}
					}
					return;
				}

				var file = new PropFile(vscode.Uri.file(f), this.repo, [], this.diags);
				file.parse(text);
				entries.push(...file.conf);
			});
		}

		return entries;
	}

	getSymbolName(document: vscode.TextDocument, position: vscode.Position) {
		var range = document.getWordRangeAtPosition(position);
		var word = document.getText(range);
		switch (document.languageId) {
			case 'kconfig':
				return word;
			default:
				if (word.startsWith('CONFIG_')) {
					return word.slice('CONFIG_'.length);
				} else if (word.startsWith('BR2_')) {
					return word;
				}
		}
		return '';
	}

	provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location | vscode.Location[] | vscode.LocationLink[]> {
		if (document.languageId === 'c' && !kEnv.getConfig('cfiles')) {
			return null;
		}


		var config = this.repo.configs[this.getSymbolName(document, position)];
		if (config) {
			return ((config.entries.length === 1) ?
				config.entries :
				config.entries.filter(e => e.file.uri.fsPath !== document.uri.fsPath || position.line < e.lines.start || position.line > e.lines.end))
				.map(e => e.loc);
		}
		return null;
	}

	provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
		if (document.languageId === 'c' && !kEnv.getConfig('cfiles')) {
			return null;
		}

		var entry = this.repo.configs[this.getSymbolName(document, position)];
		if (!entry) {
			return null;
		}
		var text = new Array<vscode.MarkdownString>();
		text.push(new vscode.MarkdownString(`${entry.text || entry.name}`));
		if (entry.type) {
			var typeLine = new vscode.MarkdownString(`\`${entry.type}\``);
			if (entry.ranges.length === 1) {
				typeLine.appendMarkdown(`\t\tRange: \`${entry.ranges[0].min}\`-\`${entry.ranges[0].max}\``);
			}
			text.push(typeLine);
		}
		if (entry.help) {
			text.push(new vscode.MarkdownString(entry.help));
		}
		return new vscode.Hover(text, document.getWordRangeAtPosition(position));
	}

	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
		// TODO: add completion for Makefiles and C
		// TODO: for now the Makefile and C only has support for the definition
		var line = document.lineAt(position.line);
		var isProperties = (document.languageId === 'defconfig' || line.text.startsWith("CONFIG_") || line.text.startsWith("BR2_"));
		var items: vscode.CompletionItem[];

		if (!isProperties && !line.text.match(/(if|depends\s+on|select|default|def_bool|def_tristate|def_int|def_hex|range)/)) {
			if (line.firstNonWhitespaceCharacterIndex > 0) {
				return this.propertyCompletions;
			}

			return this.rootCompletions;
		}

		if (isProperties) {
			var lineRange = new vscode.Range(position.line, 0, position.line, 999999);
			var lineText = document.getText(lineRange);
			var replaceText = lineText.replace(/\s*#.*$/, '');
		}

		const kinds = {
			'config': vscode.CompletionItemKind.Variable,
			'menuconfig': vscode.CompletionItemKind.Class,
			'choice': vscode.CompletionItemKind.Enum,
		};

		items = this.repo.configList.map(e => {
			var item;

			if (e.name.startsWith("BR2_")) {
				item = new vscode.CompletionItem(e.name, (e.kind ? kinds[e.kind] : vscode.CompletionItemKind.Text));
			} else {
				item = new vscode.CompletionItem(isProperties ? `CONFIG_${e.name}` : e.name, (e.kind ? kinds[e.kind] : vscode.CompletionItemKind.Text));
			}

			item.sortText = e.name;
			item.detail = e.text;
			if (isProperties) {
				if (replaceText.length > 0) {
					item.range = new vscode.Range(position.line, 0, position.line, replaceText.length);
				}

				item.insertText = new vscode.SnippetString(`${item.label}=`);
				switch (e.type) {
					case 'bool':
						if (e.defaults.length > 0 && e.defaults[0].value === 'y') {
							item.insertText.appendPlaceholder('n');
						} else {
							item.insertText.appendPlaceholder('y');
						}
						break;
					case 'tristate':
						item.insertText.appendPlaceholder('y');
						break;
					case 'int':
					case 'string':
						if (e.defaults.length > 0) {
							item.insertText.appendPlaceholder(e.defaults[0].value);
						} else {
							item.insertText.appendTabstop();
						}
						break;
					case 'hex':
						if (e.defaults.length > 0) {
							item.insertText.appendPlaceholder(e.defaults[0].value);
						} else {
							item.insertText.appendText('0x');
							item.insertText.appendTabstop();
						}
						break;
					default:
						break;
				}
			}

			return item;
		});

		if (!isProperties) {
			items.push(new vscode.CompletionItem('if', vscode.CompletionItemKind.Keyword));
		}

		return items;
	}

	resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
		if (!item.sortText) {
			return item;
		}
		var e = this.repo.configs[item.sortText];
		if (!e) {
			return item;
		}
		var doc = new vscode.MarkdownString(`\`${e.type}\``);
		if (e.ranges.length === 1) {
			doc.appendMarkdown(`\t\tRange: \`${e.ranges[0].min}\`-\`${e.ranges[0].max}\``);
		}
		if (e.help) {
			doc.appendText('\n\n');
			doc.appendMarkdown(e.help);
		}
		if (e.defaults.length > 0) {
			if (e.defaults.length > 1) {
				doc.appendMarkdown('\n\n### Defaults:\n');
			} else {
				doc.appendMarkdown('\n\n**Default:** ');
			}
			e.defaults.forEach(dflt => {
				doc.appendMarkdown(`\`${dflt.value}\``);
				if (dflt.condition) {
					doc.appendMarkdown(` if \`${dflt.condition}\``);
				}
				doc.appendMarkdown('\n\n');
			});
		}
		item.documentation = doc;
		return item;
	}

	provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.DocumentLink[] {
		var file = this.repo.files.find(f => f.uri.fsPath === document.uri.fsPath);
		return file?.links ?? [];
	}

	provideReferences(document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.ReferenceContext,
		token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location[]> {
		var entry = this.repo.configs[this.getSymbolName(document, position)];
		if (!entry || !entry.type || !['bool', 'tristate'].includes(entry.type)) {
			return null;
		}
		return this.repo.configList
			.filter(config => (
				config.allSelects(entry.name).length > 0 ||
				config.hasDependency(entry!.name)))
			.map(config => config.entries[0].loc); // TODO: return the entries instead?
	}

	provideCodeActions(document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeAction[]> {
		if (document.uri.fsPath in this.propFiles) {
			return this.propFiles[document.uri.fsPath].actions
				.filter(a => (!context.only || context.only === a.kind) && a.diagnostics?.[0].range.intersection(range));
		}
	}

	provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentSymbol[]> {
		if (document.languageId === 'defconfig') {
			return this.propFile(document.uri)
				.overrides.filter(o => o.line !== undefined)
				.map(
					o =>
						new vscode.DocumentSymbol(
							o.config.name,
							o.config.text ?? "",
							o.config.symbolKind(),
							new vscode.Range(o.line!, 0, o.line!, 99999),
							new vscode.Range(o.line!, 0, o.line!, 99999)
						)
				);
		}
		var file = this.repo.files.find(f => f.uri.fsPath === document.uri.fsPath);
		if (!file) {
			return [];
		}

		var addScope = (scope: Scope): vscode.DocumentSymbol => {
			var name: string = scope.name;
			if ((scope instanceof IfScope) && (scope.expr?.operator === Operator.VAR)) {
				var config = this.repo.configs[scope.expr.var!.value];
				name = config?.text ?? config?.name ?? scope.name;
			}

			var symbol = new vscode.DocumentSymbol(name, '',
				scope.symbolKind,
				scope.range,
				new vscode.Range(scope.lines.start, 0, scope.lines.start, 9999));

			symbol.children = (scope.children.filter(c => !(c instanceof Comment) && c.file === file) as (Scope | ConfigEntry)[])
			.map(c =>
				(c instanceof Scope)
					? addScope(c)
					: new vscode.DocumentSymbol(
							c.config.text ?? c.config.name,
							'',
							c.config.symbolKind(),
							new vscode.Range(c.lines.start, 0, c.lines.end, 9999),
							new vscode.Range(c.lines.start, 0, c.lines.start, 9999)
					  )
			)
			.reduce((prev, curr) => {
				if (prev.length > 0 && curr.name === prev[prev.length - 1].name) {
					prev[prev.length - 1].children.push(...curr.children);
					prev[prev.length - 1].range = prev[prev.length - 1].range.union(curr.range);
					return prev;
				}
				return [...prev, curr];
			}, new Array<vscode.DocumentSymbol>());

			return symbol;
		};

		return addScope(file.scope).children;
	}

	provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SymbolInformation[]> {
		var entries: Config[];
		query = query?.replace(/^(CONFIG_)?/, '');

		if (query) {
			entries = fuzzy.go(query, this.repo.configList, { key: 'name' }).map(result => result.obj);
		} else {
			entries = this.repo.configList;
		}

		return entries.map(e => new vscode.SymbolInformation(
			`CONFIG_${e.name}`,
			vscode.SymbolKind.Property,
			e.text ?? '',
			e.entries[0].loc));
	}

}
