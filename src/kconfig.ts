/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import { resolveExpression, createExpression, Expression } from './evaluate';
import { ParsedFile } from './parse';

export type ConfigValue = string | number | boolean;
export type ConfigValueRange = { max: string, min: string, condition?: Expression };
export type ConfigValueType = 'string' | 'int' | 'hex' | 'bool' | 'tristate';
export type ConfigOverride = { config: Config, value: string, line?: number };
export type ConfigKind = 'config' | 'menuconfig' | 'choice';
export type ConfigDefault = {value: string, condition?: Expression};
export type ConfigSelect = {name: string, condition?: Expression};
export type LineRange = {start: number, end: number};

export class EvalContext {
	repo: Repository;
	overrides: ConfigOverride[];
	evaluated: {[name: string]: ConfigValue};

	constructor(repo: Repository, overrides: ConfigOverride[]) {
		this.repo = repo;
		this.overrides = overrides;
		this.evaluated = {};
	}

	/* Cache results: */

	register(c: Config | Scope, value: ConfigValue): ConfigValue {
		this.evaluated[(c instanceof Config) ? c.name : c.id] = value;
		return value;
	}

	resolve(c: Config | Scope): ConfigValue | undefined {
		return this.evaluated[(c instanceof Config) ? c.name : c.id];
	}
}

export class Comment {
	visible?: Expression;
	file: ParsedFile;
	text: string;
	line: number;

	constructor(text: string, file: ParsedFile, line: number) {
		this.text = text;
		this.file = file;
		this.line = line;
	}
}

export abstract class Scope {
	lines: LineRange;
	private _name: string;
	file: ParsedFile;
	parent?: Scope;
	children: (Scope | ConfigEntry | Comment)[];
	id: string;
	symbolKind: vscode.SymbolKind;

	constructor(type: string, name: string, repo: Repository, line: number, file: ParsedFile, symbolKind: vscode.SymbolKind, parent?: Scope) {
		this._name = name;
		this.lines = {start: line, end: line};
		this.file = file;
		this.parent = parent;
		this.id = type + '(' + name + ')';
		this.symbolKind = symbolKind;
		this.children = [];

		if (parent) {
			this.id = parent.id + '::' + this.id;
		} else if (!(this instanceof RootScope)) {
			console.error(`Orphan scope: ${this.id} @ ${this.file.uri.fsPath}:${line}`);
		}
	}

	public get name(): string {
		return this._name;
	}
	public set name(value: string) {
		this._name = value;
	}

	addScope(s: Scope): Scope {
		var existing = this.children.find(c => (c instanceof Scope) && c.id === s.id && c.file === s.file) as Scope;
		if (existing) {
			existing.lines = s.lines;
			return existing;
		}

		this.children.push(s);
		return s;
	}

	get range(): vscode.Range {
		return new vscode.Range(this.lines.start, 0, this.lines.end, 9999);
	}

	match(other: Scope): boolean {
		return this.id === other.id;
	}

	evaluate(ctx: EvalContext): boolean {
		var result = ctx.resolve(this);
		if (result !== undefined) {
			return !!result;
		}

		result = this.resolve(ctx) && (this.parent?.evaluate(ctx) ?? true);
		ctx.register(this, result);
		return result;
	}

	protected abstract resolve(ctx: EvalContext): boolean;
}

export class IfScope extends Scope {
	expr?: Expression;
	rawExpr: string;
	parent: Scope;
	constructor(expression: string, repo: Repository, line: number, file: ParsedFile, parent: Scope) {
		super('if', expression, repo, line, file, vscode.SymbolKind.Module, parent);
		/* Creating the expression now incurs a 30% performance penalty on parsing,
		* but makes config file evaluation MUCH faster */
		this.expr = createExpression(expression);
		this.rawExpr = expression;
		this.parent = parent;
	}

	resolve(ctx: EvalContext) {
		return !!(this.expr?.solve(ctx) ?? true); // default to false instead?
	}
}

export class MenuScope extends Scope {
	dependencies: string[];
	visible?: Expression;
	parent: Scope;

	constructor(prompt: string, repo: Repository, line: number, file: ParsedFile, parent: Scope) {
		super('menu', prompt, repo, line, file, vscode.SymbolKind.Class, parent);
		this.dependencies = [];
		this.parent = parent;
	}

	resolve(ctx: EvalContext) {
		return this.dependencies.every(d => resolveExpression(d, ctx));
	}
}

export class ChoiceScope extends Scope {
	choice: ChoiceEntry;
	parent: Scope;
	constructor(choice: ChoiceEntry) {
		super('choice', choice.config.name, choice.config.repo, choice.lines.start, choice.file, vscode.SymbolKind.Enum, choice.scope);
		this.choice = choice;
		this.parent = choice.scope;
	}

	// Override name property to dynamically get it from the ConfigEntry:
	get name(): string {
		return this.choice.text || this.choice.config.name;
	}

	set name(name: string) {}

	resolve(ctx: EvalContext) {
		return true;
	}
}

export class RootScope extends Scope {

	constructor(repo: Repository) {
		super('root', 'ROOT', repo, 0, new ParsedFile(repo, vscode.Uri.parse('commandline://'), {}, repo.rootScope), vscode.SymbolKind.Class);
	}

	resolve(ctx: EvalContext) {
		return true;
	}

	reset() {
		this.children = [];
	}
}

export class ConfigEntry {
	config: Config;
	lines: LineRange;
	file: ParsedFile;
	help?: string;
	scope: Scope;
	ranges: ConfigValueRange[];
	type?: ConfigValueType;
	text?: string;
	prompt: boolean;
	dependencies: string[];
	selects: ConfigSelect[];
	implys: ConfigSelect[];
	defaults: ConfigDefault[];

	constructor(config: Config, line: number, file: ParsedFile, scope: Scope) {
		this.config = config;
		this.lines = {start: line, end: line};
		this.file = file;
		this.scope = scope;
		this.ranges = [];
		this.dependencies = [];
		this.selects = [];
		this.implys = [];
		this.defaults = [];
		this.prompt = false;

		if (scope) {
			scope.children.push(this);
		}

		this.config.entries.push(this);
	}

	extend(lineNumber: number)  {
		if (lineNumber < this.lines.start) {
			throw new Error("Extending upwards, shouldn't be possible.");
		}
		if (lineNumber <= this.lines.end) {
			return;
		}

		this.lines.end = lineNumber;
	}

	get loc(): vscode.Location {
		return new vscode.Location(this.file.uri, new vscode.Range(this.lines.start, 0, this.lines.end, 99999));
	}

	isActive(ctx: EvalContext): boolean {
		return this.dependencies.every(d => resolveExpression(d, ctx)) && this.scope.evaluate(ctx);
	}
}

export class Config {
	name: string;
	kind: ConfigKind;
	entries: ConfigEntry[];
	readonly repo: Repository;

	constructor(name: string, kind: ConfigKind, repo: Repository) {
		this.name = name;
		this.kind = kind;
		this.repo = repo;
		this.entries = [];
	}

	get type(): ConfigValueType | undefined {
		return this.entries.find(e => e.type)?.type;
	}

	get help(): string {
		return this.entries.filter(e => e.help).map(e => e.help).join('\n\n');
	}

	get text(): string | undefined {
		return this.entries.find(e => e.text)?.text;
	}

	get defaults(): ConfigDefault[] {
		var defaults: ConfigDefault[] = [];
		this.entries.forEach(e => defaults.push(...e.defaults));
		return defaults;
	}

	get ranges(): ConfigValueRange[] {
		var ranges: ConfigValueRange[] = [];
		this.entries.forEach(e => ranges.push(...e.ranges));
		return ranges;
	}

	get implys(): ConfigSelect[] {
		var implys: ConfigSelect[] = [];
		this.entries.forEach(e => implys.push(...e.implys));
		return implys;
	}

	get mainEntry(): ConfigEntry | undefined {
		return this.entries.find(e => e.text);
	}

	get dependencies(): string[] {
		var dependencies: string[] = [];
		this.entries.forEach(e => dependencies.push(...e.dependencies));
		return dependencies;
	}

	activeEntries(ctx: EvalContext): ConfigEntry[] {
		return this.entries.filter(e => e.isActive(ctx));
	}

	selects(ctx: EvalContext, name: string): Config[] {
		var configs = <Config[]>[];
		this.entries.forEach(e => {
			configs.push(
				...e.selects
					.filter(s => (s.name === name) && (!s.condition || s.condition.solve(ctx)))
					.map(s => ctx.repo.configs[s.name])
					.filter(c => c !== undefined)
			);
			configs.push(
				...e.implys
					.filter(s => (s.name === name) && !ctx.overrides.some(o => o.config.name === name) && (!s.condition || s.condition.solve(ctx)))
					.map(s => ctx.repo.configs[s.name])
					.filter(c => c !== undefined)
			);
		});

		if (configs.length > 0 && !this.evaluate(ctx)) {
			return [];
		}

		return configs;
	}

	allSelects(entryName: string): ConfigSelect[] {
		var selects: ConfigSelect[] = [];
		this.entries.forEach(e => selects.push(...e.selects.filter(s => s.name === entryName)));
		return selects;
	}

	hasDependency(name: string) {
		return this.entries.some(e => e.dependencies.some(s => s.includes(name)));
	}

	removeEntry(entry: ConfigEntry) {
		var i = this.entries.indexOf(entry);
		this.entries.splice(i, 1);
		if (entry.scope) {
			i = entry.scope.children.indexOf(entry);
			entry.scope.children.splice(i, 1);
		}

		if (this.entries.length === 0) {
			delete this.repo.configs[this.name];
		}
	}

	isValidOverride(overrideValue: string): boolean {
		switch (this.type) {
			case 'bool':
				return ['y', 'n'].includes(overrideValue);
			case 'tristate':
				return ['y', 'n', 'm'].includes(overrideValue);
			case 'hex':
				return !!overrideValue.match(/^0x[a-fA-F\d]+$/);
			case 'int':
				return !!overrideValue.match(/^\d+$/);
			case 'string':
				return !!overrideValue.match(/^"[^"]*"/);
			default:
				return false;
		}
	}

	defaultValue(ctx: EvalContext): ConfigValue | undefined {
		var dflt: ConfigDefault | undefined;
		this.activeEntries(ctx).some(e => {
			dflt = e.defaults.find(d => !d.condition || d.condition.solve(ctx) === true);
			return dflt !== undefined;
		});

		if (dflt !== undefined) {
			return resolveExpression(dflt.value, ctx);
		}

		return undefined;
	}

	isEnabled(value: string) {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return value === 'y';
			case 'int':
				return value !== '0';
			case 'hex':
				return value !== '0x0';
			default:
				return true;
		}
	}

	resolveValueString(value: string): ConfigValue {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return value === 'y' || value === 'm';
			case 'int':
			case 'hex':
				return Number(value);
			case 'string':
				return value;
			default:
				return false;
		}
	}

	toValueString(value: ConfigValue): string {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return value ? 'y' : 'n';
			case 'int':
				return value.toString(10);
			case 'hex':
				return '0x' + value.toString(16);
			case 'string':
				return `"${value}"`;
			default:
				return 'n';
		}
	}

	getRange(ctx: EvalContext): {min: number, max: number} {
		var range: ConfigValueRange | undefined;
		this.activeEntries(ctx).find(e => {
			range = e.ranges.find(r => r.condition === undefined || r.condition.solve(ctx) === true);
			return range;
		});

		if (range) {
			return {
				min: this.evaluateSymbol(range.min, ctx) as number,
				max: this.evaluateSymbol(range.max, ctx) as number,
			};
		}

		return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };

	}

	evaluateSymbol(name: string, ctx: EvalContext): ConfigValue {
		if (name.match(/^\s*(0x[\da-fA-F]+|[\-+]?\d+)\s*$/)) {
			return Number(name);
		} else if (name.match(/^\s*[ynm]\s*$/)) {
			return name.trim() !== 'n';
		}

		var symbol = ctx.repo.configs[name];
		if (!symbol) {
			return false;
		}
		return symbol.evaluate(ctx);
	}

	missingDependency(ctx: EvalContext): string | undefined {
		return this.mainEntry?.dependencies.find(d => !resolveExpression(d, ctx));
	}

	missingDependencies(ctx: EvalContext): string[] {
		let deps = this.mainEntry?.dependencies.filter(d => !resolveExpression(d, ctx)) ?? [];
		let scope = this.mainEntry?.scope;
		while (scope) {
			if (scope instanceof IfScope && !scope.evaluate(ctx)) {
				deps.push(scope.rawExpr);
			}

			scope = scope.parent;
		}

		return deps;
	}

	selector(ctx: EvalContext): Config | undefined {
		if (this.type !== 'bool' && this.type !== 'tristate') {
			return undefined;
		}

		var select = ctx.repo.configList.find(
			c => (
				(c.type === 'bool' || c.type === 'tristate') &&
				!c.hasDependency(this.name) &&
				(c.selects(ctx, this.name).length > 0)
			)
		);

		return select;
	}

	falseValue(ctx: EvalContext) {
		if (!this.text) {
			return false;
		}


		switch (this.type) {
			case "bool":
			case "tristate":
				return false;
			case "hex":
			case "int":
				if (this.ranges.length > 0) {
					return this.getRange(ctx).min;
				}
				return 0;
			case "string":
				return "";
		}
		return false;
	}

	evaluate(ctx: EvalContext): ConfigValue {
		// Check cached result first:
		var result = ctx.resolve(this);
		if (result !== undefined) {
			return result;
		}

		// All dependencies must be true
		if (this.missingDependency(ctx)) {
			return ctx.register(this, false);
		}

		if (!this.entries.some(e => e.type && e.isActive(ctx))) {
			return ctx.register(this, false);
		}

		var override = ctx.overrides.find(o => o.config.name === this.name);
		if (override) {
			return ctx.register(this, this.resolveValueString(override.value));
		}

		var dflt = this.defaultValue(ctx);
		if (dflt !== undefined) {
			return ctx.register(this, dflt);
		}

		if (this.type === "bool" || this.type === "tristate") {
			var selected = !!this.selector(ctx);
			if (selected) {
				return ctx.register(this, selected);
			}

			if (this.entries[0].scope instanceof ChoiceScope && this.entries[0].scope.choice.chosen(ctx) === this) {
				return true;
			}
		}

		return ctx.register(this, this.falseValue(ctx));
	}

	symbolKind(): vscode.SymbolKind {
		switch (this.kind) {
			case "choice":
				return vscode.SymbolKind.Enum;
			case "menuconfig":
				return vscode.SymbolKind.Class;
			case "config":
				switch (this.type) {
					case "bool": return vscode.SymbolKind.Property;
					case "tristate": return vscode.SymbolKind.EnumMember;
					case "int": return vscode.SymbolKind.Number;
					case "hex": return vscode.SymbolKind.Number;
					case "string": return vscode.SymbolKind.String;
				}
				/* Intentionall fall-through: Want undefined types to be handled like undefined kinds */
			case undefined:
				return vscode.SymbolKind.Null;
		}
	}

	completionKind(): vscode.CompletionItemKind {
		switch (this.kind) {
			case "choice":
				return vscode.CompletionItemKind.Class;
			case "menuconfig":
				return vscode.CompletionItemKind.Field;
			case "config":
				switch (this.type) {
					case "bool": return vscode.CompletionItemKind.Field;
					case "tristate": return vscode.CompletionItemKind.Field;
					case "int": return vscode.CompletionItemKind.Property;
					case "hex": return vscode.CompletionItemKind.Property;
					case "string": return vscode.CompletionItemKind.Keyword;
				}
				/* Intentional fall-through: Want undefined types to be handled like undefined kinds */
			case undefined:
				return vscode.CompletionItemKind.Property;
		}
	}

	toString(): string {
		return `Config(${this.name})`;
	}
}

export class ChoiceEntry extends ConfigEntry {
	choices: Config[];
	optional = false;

	constructor(name: string, line: number, repo: Repository, file: ParsedFile, scope: Scope) {
		super(new Config(name, 'choice', repo), line, file, scope);
		this.choices = [];
	}

	chosen(ctx: EvalContext): Config | undefined {
		var c = this.choices.find(c => ctx.overrides.some(o => o.config === c && c.resolveValueString(o.value)));
		if (c) {
			return c;
		}

		var dflt = this.defaults.find(d => !d.condition || d.condition.solve(ctx));
		if (dflt) {
			return this.choices.find(c => c.name === dflt!.value.trim());
		}

		if (!this.optional && this.choices.length > 0) {
			return this.choices[0];
		}
	}
}

export class Repository {
	configs: {[name: string]: Config};

	private cachedConfigList?: Config[];
	root?: ParsedFile;
	rootScope: RootScope;
	diags: vscode.DiagnosticCollection;
	openEditors: vscode.Uri[];

	constructor(diags: vscode.DiagnosticCollection) {
		this.configs = {};
		this.diags = diags;
		this.openEditors = vscode.window.visibleTextEditors.filter(e => e.document.languageId === "kconfig").map(e => e.document.uri);
		this.openEditors.forEach(uri => this.setDiags(uri));
		this.cachedConfigList = [];
		this.rootScope = new RootScope(this);
	}

	activate(context: vscode.ExtensionContext) {
		context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(e => {
			e = e.filter(e => e.document.languageId === 'kconfig');
			var newUris = e.map(e => e.document.uri);
			var removed = this.openEditors.filter(old => !newUris.some(uri => uri.fsPath === old.fsPath));
			var added = newUris.filter(newUri => !this.openEditors.some(uri => uri.fsPath === newUri.fsPath));

			removed.forEach(removed => this.diags.delete(removed));
			added.forEach(add => this.setDiags(add));

			this.openEditors = newUris;
		}));
	}

	get configList() {
		if (this.cachedConfigList === undefined) {
			this.cachedConfigList = Object.values(this.configs);
		}

		return this.cachedConfigList;
	}

	setRoot(uri: vscode.Uri) {
		this.configs = {};
		this.rootScope.reset();
		this.root = new ParsedFile(this, uri, {}, this.rootScope);
	}

	async parse() {
		this.cachedConfigList = undefined;
		await this.root?.parse();
		this.openEditors.forEach(uri => this.setDiags(uri));
		this.printStats();
	}

	reset() {
		this.rootScope.reset();
		this.configs = {};
		this.cachedConfigList = undefined;
	}

	get files(): ParsedFile[] { // TODO: optimize to a managed dict?
		if (!this.root) {
			return [];
		}

		return [this.root, ...this.root.children()];
	}

	setDiags(uri: vscode.Uri) {
		this.diags.set(uri,
			this.files
				.filter(f => f.uri.fsPath === uri.fsPath)
				.map(f => f.diags)
				.reduce((sum, diags) => sum.concat(diags.filter(d => !sum.some(existing => existing.range.start.line === d.range.start.line))), []));
	}

	onDidChange(uri: vscode.Uri, change?: vscode.TextDocumentChangeEvent) {
		if (change && change.contentChanges.length === 0) {
			return;
		}

		var hrTime = process.hrtime();

		var files = this.files.filter(f => f.uri.fsPath === uri.fsPath);
		if (!files.length) {
			return;
		}

		this.cachedConfigList = undefined;
		files.forEach(f => f.onDidChange(change));
		hrTime = process.hrtime(hrTime);

		this.openEditors.forEach(uri => this.setDiags(uri));
		if (vscode.debug.activeDebugSession) {
			console.log(`Kconfig: Handled changes to ${files.length} versions of ${uri.fsPath} in ${hrTime[0] * 1000 + hrTime[1] / 1000000} ms.`);
			this.printStats();
		}
	}

	printStats() {
		console.log(`\tKconfig: Files: ${this.files.length}`);
		console.log(`\tKconfig: Configs: ${this.configList.length}`);
		console.log(`\tKconfig: Empty configs: ${this.configList.filter(c => c.entries.length === 0).length}`);
		var entriesC = this.configList.map(c => c.entries).reduce((sum, num) => [...sum, ...num], []);
		console.log(`\tKconfig: Entries: ${entriesC.length}`);

		var scopeEntries = (s: Scope) : ConfigEntry[] => {
			return s.children.map(c => (c instanceof Comment) ? [] : (c instanceof Scope) ? scopeEntries(c) : (c.config.kind === 'choice') ? [] : [c]).reduce((sum, num) => [...sum, ...num], []);
		};
		var entriesS = scopeEntries(this.rootScope);
		console.log(`\tKconfig: Entries from scopes: ${entriesS.length}`);

		// console.log(`\tMissing Scope entries: ${entriesC.filter(e => !entriesS.includes(e)).map(e => e.config.name)}`);
		// console.log(`\tMissing Config entries: ${entriesS.filter(e => !entriesC.includes(e)).map(e => e.config.name)}`);
	}
}
