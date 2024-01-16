/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as glob from "glob";
import { Repository, Scope, Config, ConfigValueType, ConfigEntry, ConfigKind, IfScope, MenuScope, ChoiceScope, ChoiceEntry, Comment } from "./kconfig";
import * as kEnv from './env';
import { createExpression } from './evaluate';

type FileInclusion = {range: vscode.Range, file: ParsedFile};

export class ParsedFile {
	// Some properties are immutable, and are part of the file's identification:
	readonly uri: vscode.Uri;
	readonly repo: Repository;
	readonly parent?: ParsedFile;
	readonly env: {[name: string]: string};
	readonly scope: Scope;

	version: number;
	inclusions: FileInclusion[];
	entries: ConfigEntry[];
	diags: vscode.Diagnostic[];

	constructor(repo: Repository, uri: vscode.Uri, env: {[name: string]: string}, scope: Scope, parent?: ParsedFile) {
		this.repo = repo;
		this.uri = uri;
		this.env = { ...env };
		this.scope = scope;
		this.parent = parent;

		this.inclusions = [];
		this.entries = [];
		this.diags = [];
		this.version = 0;
	}

	match(other: ParsedFile) : boolean {
		var myEnvKeys = Object.keys(this.env);
		return (
			this.uri.fsPath === other.uri.fsPath &&
			Object.keys(other.env).length === myEnvKeys.length &&
			myEnvKeys.every(key => key in other.env && other.env[key] === this.env[key]) &&
			(this.scope === other.scope || (!!this.scope && !!other.scope?.match(this.scope))) &&
			(this.parent === other.parent || (!!this.parent && !!other.parent?.match(this.parent)))
		);
	}

	get links(): vscode.DocumentLink[] {
		var thisDir = path.dirname(this.uri.fsPath);
		return this.inclusions.map(i => {
			var link = new vscode.DocumentLink(i.range, i.file.uri);
			if (i.file.uri.scheme === 'file') {
				link.tooltip = path.relative(thisDir, i.file.uri.fsPath);
			}
			return link;
		});
	}

	onDidChange(change?: vscode.TextDocumentChangeEvent) {
		if (change) {
			if (change.document.version === this.version) {
				console.log(`Kconfig: Duplicate version of ${change.document.fileName}`);
				return;
			}
			this.version = change.document.version;
			var firstDirtyLine = Math.min(...change.contentChanges.map(c => c.range.start.line));
		}

		var oldInclusions = this.inclusions;

		if (this.scope) {
			this.scope.children = this.scope.children.filter(c => !(c instanceof Scope) || (c.file !== this));
		}

		this.wipeEntries();

		this.parseRaw(change ? change.document.getText() : kEnv.readFile(this.uri));

		this.inclusions.forEach(i => {
			var existingIndex: number;
			if (i.range.end.line < firstDirtyLine) { // Optimization, matching is a bit expensive
				existingIndex = oldInclusions.findIndex(ii => ii.range.start.line === i.range.start.line);
			} else {
				existingIndex = oldInclusions.findIndex(ii => ii.file.match(i.file));
			}

			if (existingIndex > -1) {
				i.file = oldInclusions.splice(existingIndex, 1)[0].file;
			} else {
				i.file.parse();
			}
		});

		// the remaining old inclusions have been removed from the new version of the document, recursively wipe that tree:
		oldInclusions.forEach(i => i.file.delete());
	}

	wipeEntries() {
		this.entries.splice(0).forEach(e => {
			e.config.removeEntry(e);
		});
	}

	delete() {
		this.wipeEntries();
		if (this.scope) {
			this.scope.children = this.scope.children.filter(c => c.file !== this);
		}

		this.inclusions.splice(0).forEach(i => i.file.delete());
	}

	reset() {
		this.diags = [];
		this.inclusions = [];
	}

	children(): ParsedFile[] {
		var files: ParsedFile[] = [];

		this.inclusions.forEach(i => {
			files.push(i.file);
			files.push(...i.file.children());
		});

		return files;
	}

	async parse() {
		this.parseRaw(kEnv.readFile(this.uri));

		await Promise.all(
			this.inclusions.map(i => i.file.parse())
		);
	}

	private parseRaw(text: string) {
		this.reset();
		var choice: ChoiceEntry | null = null;
		var env = {...this.env};
		var scope = this.scope;
		if (scope instanceof ChoiceScope) {
			choice = scope.choice;
		}

		var lines = text.split(/\r?\n/g);
		if (!lines) {
			return;
		}

		var setScope = (s: Scope) => {
			if (s && scope) {
				scope = scope.addScope(s);
			} else {
				scope = s;
			}
		};

		var unterminatedScope = (s?: Scope) => {
			if (s) {
				var type = s.id.split('(')[0];
				this.diags.push(
					new vscode.Diagnostic(
						new vscode.Range(s.lines.start, 0, s.lines.start, 9999),
						`Unterminated ${type}. Expected matching end${type} before end of parent scope.`,
						vscode.DiagnosticSeverity.Error
					)
				);
			}
		};

		const configMatch    = /^\s*(menuconfig|config)\s+(\w+)/;
		const sourceMatch    = /^(\s*(o)?(r)?source\s+)"((?:.*?[^\\])?)"/;
		const choiceMatch    = /^\s*choice(?:\s+(\w+))?/;
		const endChoiceMatch = /^\s*endchoice\b/;
		const ifMatch        = /^\s*if\s+([^#]+)/;
		const endifMatch     = /^\s*endif\b/;
		const menuMatch      = /^\s*((?:main)?menu)\s+"((?:.*?[^\\])?)"/;
		const endMenuMatch   = /^\s*endmenu\b/;
		const depOnMatch     = /^\s*depends\s+on\s+([^#]+)/;
		const envMatch       = /^\s*([\w\-]+)\s*=\s*([^#]+)/;
		const typeMatch      = /^\s*(bool|tristate|string|hex|int)(?:\s+"((?:.*?[^\\])?)")?/;
		const selectMatch    = /^\s*(?:select|imply)\s+(\w+)(?:\s+if\s+([^#]+))?/;
		const promptMatch    = /^\s*prompt\s+"((?:.*?[^\\])?)"/;
		const helpMatch      = /^\s*help\b/;
		const defaultMatch   = /^\s*default\s+([^#]+)/;
		const visibleMatch   = /^\s*visible\s+if\s+([^#]+)/;
		const defMatch       = /^\s*def_(bool|tristate|int|hex)\s+([^#]+)/;
		const defStringMatch = /^\s*def_string\s+"((?:.*?[^\\])?)"(?:\s+if\s+([^#]+))?/;
		const rangeMatch     = /^\s*range\s+([\-+]?\w+|\$\(.*?\))\s+([\-+]?\w+|\$\(.*?\))(?:\s+if\s+([^#]+))?/;

		var entry: ConfigEntry | null = null;
		var comment: Comment | null = null;
		var help = false;
		var helpIndent: string | null = null;
		for (var lineNumber = 0; lineNumber < lines.length; lineNumber++) {
			var line = kEnv.replace(lines[lineNumber], env);

			var startLineNumber = lineNumber;

			/* If lines end with \, the line ending should be ignored: */
			while (line.endsWith('\\') && lineNumber < lines.length - 1) {
				line = line.slice(0, line.length - 1) + kEnv.replace(lines[++lineNumber], env);
			}

			if (line.length === 0) {
				if (help && entry?.help) {
					entry.help += '\n\n';
				}
				continue;
			}

			var lineRange = new vscode.Range(startLineNumber, 0, lineNumber, line.length);

			if (help) {
				var indent = line.replace(/\t/g, ' '.repeat(8)).match(/^\s*/)![0];
				if (helpIndent === null) {
					helpIndent = indent;
				}
				if (indent.startsWith(helpIndent)) {
					if (entry) {
						entry.help += ' ' + line.trim();
						entry.extend(lineNumber);
					}
				} else {
					help = false;
					if (entry && entry.help) {
						entry.help = entry.help.trim();
					}
				}
			}

			if (help) {
				continue;
			}

			if (line.match(/^\s*(#|$)/)) {
				continue;
			}

			var name: string;
			var match = line.match(configMatch);
			var c: Config;
			if (match) {
				name = match[2];
				if (name in this.repo.configs) {
					c = this.repo.configs[name];
				} else {
					c = new Config(name, match[1] as ConfigKind, this.repo);
					this.repo.configs[name] = c;
				}

				entry = new ConfigEntry(c, lineNumber, this, scope);

				this.entries.push(entry);

				if (choice) {
					choice.choices.push(entry.config);
				}
				continue;
			}
			match = line.match(sourceMatch);
			if (match) {
				let baseDir: string;
				let optional = !!match[2];
				let relative = !!match[3];
				if (relative) {
					baseDir = path.dirname(this.uri.fsPath);
				} else {
					baseDir = kEnv.getRoot();
				}
				let includeFile = kEnv.resolvePath(match[4], baseDir);
				let range = new vscode.Range(
					new vscode.Position(lineNumber, match[1].length + 1),
					new vscode.Position(lineNumber, match[0].length - 1));
				if (includeFile.scheme === 'file') {
					let matches = glob.sync(includeFile.fsPath);
					matches.forEach(match => {
						this.inclusions.push({range: range, file: new ParsedFile(this.repo, vscode.Uri.file(match), env, scope, this)});
					});
					if (matches.length === 0 && !optional) {
						console.log(`Kconfig: Unable to resolve include ${match[4]} @ ${this.uri.fsPath}:L${lineNumber + 1}`);
						this.diags.push(new vscode.Diagnostic(lineRange, 'Unable to resolve include'));
					}
				} else {
					this.inclusions.push({range: range, file: new ParsedFile(this.repo, includeFile, env, scope, this)});
				}
				continue;
			}
			match = line.match(choiceMatch);
			if (match) {
				name = match[1] || `<choice @ ${vscode.workspace.asRelativePath(this.uri.fsPath)}:${lineNumber}>`;
				choice = new ChoiceEntry(name, lineNumber, this.repo, this, scope);
				setScope(new ChoiceScope(choice));
				entry = choice;
				continue;
			}
			match = line.match(endChoiceMatch);
			if (match) {
				entry = null;
				choice = null;
				if (scope instanceof ChoiceScope) {
					scope.lines.end = lineNumber;
					scope = scope.parent!;
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected endchoice`, vscode.DiagnosticSeverity.Error));
					unterminatedScope(scope);
				}
				continue;
			}
			match = line.match(ifMatch);
			if (match) {
				entry = null;
				setScope(new IfScope(match[1], this.repo, lineNumber, this, scope!));
				continue;
			}
			match = line.match(endifMatch);
			if (match) {
				entry = null;
				if (scope instanceof IfScope) {
					scope.lines.end = lineNumber;
					scope = scope.parent;
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected endif`, vscode.DiagnosticSeverity.Error));
					unterminatedScope(scope);
				}
				continue;
			}
			match = line.match(menuMatch);
			if (match) {
				entry = null;
				setScope(new MenuScope(match[2], this.repo, lineNumber, this, scope!));
				continue;
			}
			match = line.match(endMenuMatch);
			if (match) {
				entry = null;
				if (scope instanceof MenuScope) {
					scope.lines.end = lineNumber;
					scope = scope.parent;
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected endmenu`, vscode.DiagnosticSeverity.Error));
					unterminatedScope(scope);
				}
				continue;
			}
			match = line.match(depOnMatch);
			if (match) {
				var depOn = match[1].trim().replace(/\s+/g, ' ');
				if (entry) {
					entry.extend(lineNumber);

					if (entry.dependencies.includes(depOn)) {
						this.diags.push(new vscode.Diagnostic(lineRange, `Duplicate dependency`, vscode.DiagnosticSeverity.Warning));
					}
					entry.dependencies.push(depOn); // need to push the duplicate, in case someone changes the other location to remove the duplication
				} else if (scope instanceof MenuScope) {
					scope.dependencies.push(depOn);
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected depends on`, vscode.DiagnosticSeverity.Error));
					unterminatedScope(scope);
				}
				continue;
			}

			match = line.match(envMatch);
			if (match) {
				env[match[1]] = match[2];
				continue;
			}

			match = line.match(visibleMatch);
			if (match) {
				if (scope instanceof MenuScope && !entry) {
					scope.visible = createExpression(match[1]);
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Only valid for menus`, vscode.DiagnosticSeverity.Error));
				}
				continue;
			}
			match = line.match(/^\s*comment\s+"(.*)"/);
			if (match) {
				comment = new Comment(match[1], this, lineNumber);
				if (scope) {
					scope.children.push(comment);
				}
				continue;
			}

			var noEntryDiag = new vscode.Diagnostic(lineRange, `Token is only valid in an entry context`, vscode.DiagnosticSeverity.Warning);

			match = line.match(typeMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.type = match[1] as ConfigValueType;
				entry.text = match[2];
				if (match[2]) {
					entry.prompt = true;
				}
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(selectMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.selects.push({name: match[1], condition: createExpression(match[2])});
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(promptMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.text = match[1];
				entry.prompt = true;
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(helpMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				help = true;
				helpIndent = null;
				entry.help = '';
				entry.extend(lineNumber);
				continue;
			}

			var ifStatement;
			match = line.match(defaultMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				ifStatement = match[1].match(/(.*)if\s+([^#]+)/);
				if (ifStatement) {
					entry.defaults.push({ value: ifStatement[1], condition: createExpression(ifStatement[2]) });
				} else {
					entry.defaults.push({ value: match[1] });
				}
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(defMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.type = match[1] as ConfigValueType;
				ifStatement = match[2].match(/(.*)if\s+([^#]+)/);
				if (ifStatement) {
					entry.defaults.push({ value: ifStatement[1], condition: createExpression(ifStatement[2]) });
				} else {
					entry.defaults.push({ value: match[2] });
				}
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(defStringMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.type = 'string';
				ifStatement = match[1].match(/(.*)if\s+([^#]+)/);
				if (ifStatement) {
					entry.defaults.push({ value: ifStatement[1], condition: createExpression(ifStatement[2]) });
				} else {
					entry.defaults.push({ value: match[1] });
				}
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(rangeMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.ranges.push({
					min: match[1],
					max: match[2],
					condition: createExpression(match[3]),
				});
				entry.extend(lineNumber);
				continue;
			}

			if (line.match(/^\s*optional\b/)) {
				if (entry instanceof ChoiceEntry) {
					entry.optional = true;
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected keyword, optional is only valid for choices.`, vscode.DiagnosticSeverity.Error));
				}
				continue;
			}

			if (line.match(/^\s*\w+\s*:\=.*/)) {
				this.diags.push(new vscode.Diagnostic(lineRange, `Macros aren't supported, this will be ignored.`, vscode.DiagnosticSeverity.Warning));
				continue;
			}

			if (line.trim().startsWith("option env=")) {
				// buildroot specific
				continue;
			}

			this.diags.push(new vscode.Diagnostic(lineRange, `Invalid token`, vscode.DiagnosticSeverity.Error));
		}
	}
}
