/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import { ConfigOverride, Repository, EvalContext } from "./kconfig";
import { Token, makeExpr, tokenizeExpression, TokenKind } from './evaluate';

export class PropFile {
	actions: vscode.CodeAction[] = [];
	conf: ConfigOverride[] = [];
	baseConf: ConfigOverride[];
	repo: Repository;
	uri: vscode.Uri;
	private diags: vscode.DiagnosticCollection;
	private timeout?: NodeJS.Timeout;
	private parseDiags: vscode.Diagnostic[] = [];
	private lintDiags: vscode.Diagnostic[] = [];
	private version: number;

	constructor(uri: vscode.Uri, repo: Repository, baseConf: ConfigOverride[], diags: vscode.DiagnosticCollection) {
		this.uri = uri;
		this.repo = repo;
		this.baseConf = baseConf;
		this.diags = diags;
		this.version = 0;
	}

	get overrides(): ConfigOverride[] {
		return this.conf.concat(this.baseConf);
	}

	parseLine(line: string, lineNumber: number): ConfigOverride | undefined {
		var thisLine = new vscode.Position(lineNumber, 0);
		//var match = line.match(/^\s*CONFIG_([^\s=]+)\s*(.*)/);
		var match = line.match(/^\s*(CONFIG_|BR2_)([^\s=]+)\s*(.*)/);
		if (!match) {
			if (!line.match(/^\s*(#|$)/)) {
				this.parseDiags.push(
					new vscode.Diagnostic(
						new vscode.Range(thisLine, thisLine),
						"Syntax error: All lines must either be comments or config entries with values.",
						vscode.DiagnosticSeverity.Error
					)
				);
			}
			return undefined;
		}

		var valueMatch = match[3].match(/(=\s*)(".*?[^\\]"|""|\w+)/);
		if (!valueMatch) {
			this.parseDiags.push(
				new vscode.Diagnostic(
					new vscode.Range(thisLine, thisLine),
					"Missing value for config " + match[2],
					vscode.DiagnosticSeverity.Error
				)
			);
			return undefined;
		}

		let entryV = match[2];

		// fixup for buildroot
		if (match.input.startsWith('BR2_')) {
			entryV = `BR2_${entryV}`;
		}

		var entry = this.repo.configs[entryV];
		if (!entry) {
			this.parseDiags.push(
				new vscode.Diagnostic(
					new vscode.Range(thisLine, thisLine),
					"Unknown entry " + match[1],
					vscode.DiagnosticSeverity.Error
				)
			);
			return undefined;
		}


		if (!entry.isValidOverride(valueMatch[2])) {
			let valueOffset = line.search(valueMatch[2]);
			var hint = '';
			switch (entry.type)  {
				case 'bool':
				case 'tristate':
					hint = 'Value must be y or n.';
					break;
				case 'hex':
					hint = 'Value must be a hexadecimal number (0x123abc).';
					break;
				case 'int':
					hint = 'Value must be a decimal number.';
					break;
				case 'string':
					hint = 'Value must be a double quoted string ("abc").';
					break;
			}

			this.parseDiags.push(
				new vscode.Diagnostic(
					new vscode.Range(lineNumber, valueOffset, lineNumber, valueOffset + valueMatch[2].length),
					`Invalid value. Entry ${match[2]} is ${entry.type === 'int' ? 'an' : 'a'} ${entry.type}. ${hint}`,
					vscode.DiagnosticSeverity.Error
				)
			);
			return undefined;
		}


		var trailing = line.slice(match[0].length).match(/^\s*([^#\s]+[^#]*)/);
		if (trailing) {
			var start = match[1].length + trailing[0].indexOf(trailing[1]);
			this.parseDiags.push(
				new vscode.Diagnostic(
					new vscode.Range(thisLine.line, start, thisLine.line, start + trailing[1].trimRight().length),
					"Unexpected trailing characters",
					vscode.DiagnosticSeverity.Error
				)
			);
			return undefined;
		}

		var value: string;
		var stringMatch = valueMatch[2].match(/^"(.*)"$/);
		if (stringMatch) {
			value = stringMatch[1];
		} else {
			value = valueMatch[2];
		}

		return { config: entry, value: value, line: lineNumber };
	}

	updateDiags() {
		this.diags.set(this.uri, [...this.parseDiags, ...this.lintDiags]);
	}

	parse(text: string) {
		this.parseDiags = [];
		this.conf = [];
		this.version++;
		console.log("Kconfig: Parsing...");

		var lines = text.split(/\r?\n/g);

		this.conf = lines.map((l, i) => this.parseLine(l, i)).filter(c => c !== undefined) as ConfigOverride[];
		this.updateDiags();
		console.log("Kconfig: Parsing done.");
	}

	reparse(d: vscode.TextDocument) {
		this.parse(d.getText());
		this.scheduleLint();
	}

	// Utility for desynchronizing context in lint
	private skipTick() {
		// Can't use await Promise.resolve(), for some reason.
		// Probably some vscode runtime is changing the behavior of this...
		return new Promise<void>(resolve => setImmediate(() => resolve()));
	}

	private getDependencyOverrides(missingDependency: string, ctx: EvalContext) {
		let entries: ConfigOverride[] = [];
		let tokens = tokenizeExpression(missingDependency);
		let variables = tokens
			.filter(t => t.kind === TokenKind.VAR)
			.map(t => this.repo.configs[t.value])
			.filter(e => (e && e.text && e.type && ['bool', 'tristate'].includes(e.type)));

		// Unless the expression is too complex, try all combinations to find one that works:
		if (variables.length > 0 && variables.length < 4) {
			// Try all combinations of the variables by iterating, using each bit as a suggested solution
			for (let bitmap = 0; bitmap < (1 << variables.length); bitmap++) {
				let replacements = variables.map((v, i) => { return { name: v.name, value: (bitmap & (1 << i)) ? 'y' : 'n' }; });
				let replacedTokens = tokens.map(t => {
					if (t.kind === TokenKind.VAR) {
						let replacement = replacements.find(r => r.name === t.value)?.value;
						if (replacement) {
							return <Token>{kind: TokenKind.TRISTATE, value: replacement};
						}
					}

					return t;
				});

				// have replaced all boolean VAR tokens with y or n depending on their bitfield value:
				if (makeExpr(replacedTokens).solve(ctx)) {
					replacements.forEach(r => {
						let dup = this.conf.find(c => r.name === c.config.name);
						let entry = null;
						if (!dup) {
							entry = {config: ctx.repo.configs[r.name], value: r.value};
						} else if (dup.value !== r.value) {
							entry = {config: dup.config, value: r.value, line: dup.line};
						} else {
							return;
						}

						// Do this recursively to brute force our way up the dependency tree:
						let entryDep = entry.config.missingDependency(ctx);
						if (entryDep) {
							entries.push(...this.getDependencyOverrides(entryDep, ctx).filter(e => !entries.some(existing => e.config.name === existing.config.name && e.value === existing.value)));
						}

						entries.push(entry);
					});
					break;
				}
			}
		}

		return entries;
	}

	async lint() {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}

		console.log("Kconfig: lint starting");
		await this.skipTick();

		var ctx = new EvalContext(this.repo, this.overrides);

		var diags = <vscode.Diagnostic[]>[];

		var actions = <vscode.CodeAction[]>[];

		var all = this.repo.configList;

		var addRedundancyAction = (c: ConfigOverride, diag: vscode.Diagnostic) => {
			var action = new vscode.CodeAction(`Remove redundant entry CONFIG_${c.config.name}`, vscode.CodeActionKind.QuickFix);
			action.edit = new vscode.WorkspaceEdit();
			action.edit.delete(this.uri, new vscode.Range(c.line!, 0, c.line! + 1, 0));
			action.diagnostics = [diag];
			actions.push(action);
		};

		var version = this.version;

		for (var i = 0; i < this.conf.length; i++) {
			await this.skipTick();
			if (version !== this.version) {
				console.log("Kconfig: Abandoning lint");
				return;
			}

			var c = this.conf[i];

			var override = c.config.resolveValueString(c.value);
			var line = new vscode.Range(c.line!, 0, c.line!, 99999999);
			var diag: vscode.Diagnostic;

			if (!c.config.text) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} has no effect (has no prompt)`,
					vscode.DiagnosticSeverity.Warning);
				diags.push(diag);
				addRedundancyAction(c, diag);

				// Find all selectors:
				var selectors = all.filter(e => e.selects(ctx, c.config.name));
				actions.push(...selectors.map(s => {
					var action = new vscode.CodeAction(`Replace with CONFIG_${s.name}`, vscode.CodeActionKind.QuickFix);
					action.edit = new vscode.WorkspaceEdit();
					action.edit.replace(this.uri, line, `CONFIG_${s.name}=y`);
					action.diagnostics = [diag];
					return action;
				}));
			}

			if (c.config.type && ['int', 'hex'].includes(c.config.type)) {
				var range = c.config.getRange(ctx);
				if (
					(range.min !== undefined && (override as number) < range.min) ||
					(range.max !== undefined && (override as number) > range.max)
				) {
					diags.push(new vscode.Diagnostic(line,
						`Value ${c.value} outside range ${range.min}-${range.max}`,
						vscode.DiagnosticSeverity.Error));
				}
			}

			// tslint:disable-next-line: triple-equals
			if (override == c.config.defaultValue(ctx)) {
				let defaultValue = c.value;
				if (c.config.type === 'bool') {
					defaultValue = c.value === 'y' ? 'enabled' : 'disabled';
				}

				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} is ${defaultValue} by default`,
					vscode.DiagnosticSeverity.Hint);
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				diags.push(diag);

				addRedundancyAction(c, diag);
			}

			var missingDependencies = c.config.missingDependencies(ctx);
			if (missingDependencies.length) {
				let depText = missingDependencies.length > 1 ? `dependencies` : `dependency ${missingDependencies[0]}`;
				if (c.value === 'n') {
					diag = new vscode.Diagnostic(line,
						`Entry is already disabled by missing ${depText}`,
						vscode.DiagnosticSeverity.Hint);
					diag.tags = [vscode.DiagnosticTag.Unnecessary];

					addRedundancyAction(c, diag);
					diags.push(diag);
					continue;
				}

				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name}: failing ${depText}`,
					vscode.DiagnosticSeverity.Warning);
				diag.relatedInformation = [];

				let overrides = new Array<ConfigOverride>();
				missingDependencies.forEach(missingDependency => {
					var dep = ctx.repo.configs[missingDependency.replace(/[!() ]/g, '')];
					if (dep?.entries?.length) {
						diag.relatedInformation!.push(new vscode.DiagnosticRelatedInformation(dep.entries[0].loc, `${dep.name} declared here`));
					}

					overrides.push(...this.getDependencyOverrides(missingDependency, ctx));
				});

				let newOverrides = overrides.filter(o => o.line === undefined);
				let existingOverrides = overrides.filter(o => o.line !== undefined);

				if (overrides.length) {
					let action = new vscode.CodeAction(`Fix ${overrides.length} missing ${overrides.length > 1 ? 'dependencies' : 'dependency'}`, vscode.CodeActionKind.QuickFix);
					action.diagnostics = [diag];

					action.edit = new vscode.WorkspaceEdit();
					if (newOverrides.length) {
						action.edit.insert(this.uri,
							new vscode.Position(c.line!, 0),
							newOverrides.map(c => `CONFIG_${c.config.name}=${c.value}\n`).join(''));
					}

					existingOverrides.forEach(e => {
						action.edit!.replace(this.uri,
							new vscode.Range(e.line!, 0, e.line!, 999999),
							`CONFIG_${e.config.name}=${e.value}`);
					});

					actions.push(action);
				} else {
				}

				diags.push(diag);
				continue;
			}

			var selector = c.config.selector(ctx);
			if (selector) {
				diag = new vscode.Diagnostic(
					line,
					`Entry ${c.config.name} is ${c.value === "n" ? "ignored" : "redundant"} (Already selected by ${selector.name})`,
					c.value === "n" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint
				);

				var o = ctx.overrides.find(o => o.config.name === selector!.name);
				if (o && o.line !== undefined) {
					diag.relatedInformation = [
						new vscode.DiagnosticRelatedInformation(
							new vscode.Location(this.uri, new vscode.Position(o.line, 0)),
							`Selected by CONFIG_${o.config.name}=${o.value}`
						)
					];
				} else {
					diag.relatedInformation = [
						new vscode.DiagnosticRelatedInformation(selector.entries[0].loc, `Selected by ${selector.name}`)
					];
				}
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				diags.push(diag);
				addRedundancyAction(c, diag);
				continue;
			}

			var actualValue = c.config.evaluate(ctx);
			if (override !== actualValue) {
				diags.push(new vscode.Diagnostic(line,
					`Entry ${c.config.name} assigned value ${c.value}, but evaluated to ${c.config.toValueString(actualValue)}`,
					vscode.DiagnosticSeverity.Warning));
				continue;
			}
		}

		console.log("Kconfig: Lint done.");
		this.lintDiags = diags;
		this.actions = actions;
		this.updateDiags();
	}

	scheduleLint() {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}

		this.timeout = setTimeout(() => {
			this.lint();
		}, 100);
	}

	onChange(e: vscode.TextDocumentChangeEvent) {
		var changes: {line: number, change: number}[] = [];
		e.contentChanges.forEach(change => {
			changes.push({
				line: change.range.start.line,
				change: change.range.start.line - change.range.end.line + (change.text.match(/\n/g) ?? []).length
			});
		});

		this.lintDiags.forEach(diag => {
			var diff = changes.reduce((sum, change, _) => (change.line <= diag.range.start.line ? sum + change.change : sum), 0);

			diag.range = new vscode.Range(
				diag.range.start.line + diff,
				diag.range.start.character,
				diag.range.end.line + diff,
				diag.range.end.character
			);
		});
		this.parse(e.document.getText());
		this.scheduleLint();
	}

	onSave(d: vscode.TextDocument) {
		this.lint();
	}

	onOpen(d: vscode.TextDocument) {
		this.reparse(d);
	}
}
