/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

var config = vscode.workspace.getConfiguration('kconfig');

export function getConfig(name: string): any {
	return config.get(name);
}

export function setConfig(name: string, value: any, target=vscode.ConfigurationTarget.Workspace) {
	config.update(name, value, target);
}

export function getRootFile(): vscode.Uri {
	var root = getConfig('root');
	if (!root) {
		// check if there is a Kconfig file in the workspace root
		const kRoot = fs.existsSync(
			path.join(vscode.workspace.rootPath!, 'Kconfig')
		);

		if (kRoot) {
			root = '${workspaceFolder}/Kconfig';
		} else {
			// buildroot
			const brRoot = fs.existsSync(
				path.join(vscode.workspace.rootPath!, 'Config.in')
			);

			if (brRoot) {
				root = '${workspaceFolder}/Config.in';
			}
		}
	}

	return resolvePath(root);
}

/// Root directory of project
export function getRoot() {
	return path.dirname(getRootFile().fsPath);
}

export function isActive(): boolean {
	var root = getRootFile();
	return !!(root && fs.existsSync(root.fsPath));
}

var env: { [name: string]: string };

export function update() {
	config = vscode.workspace.getConfiguration('kconfig');
	env = {};
	let userConf = getConfig('env');
	Object.keys(userConf).forEach(k => env[k] = userConf[k]);

	try {
		Object.keys(env).forEach(key => {
			var match;
			while ((match = env[key].match(/\${(.+?)}/)) !== null) {
				var replacement: string;
				if (match[1] === key) {
					vscode.window.showErrorMessage(`Kconfig environment is circular: variable ${key} references itself`);
					throw new Error('Kconfig environment is circular');
				} else if (match[1] in env) {
					replacement = env[match[1]];
				} else if (match[1].startsWith('workspaceFolder')) {
					if (!vscode.workspace.workspaceFolders) {
						return;
					}

					var folder = match[1].match(/workspaceFolder:(.+)/);
					if (folder) {
						var wsf = vscode.workspace.workspaceFolders.find(f => f.name === folder![1]);
						if (!wsf) {
							return;
						}
						replacement = wsf.uri.fsPath;
					} else {
						replacement = vscode.workspace.workspaceFolders[0].uri.fsPath;
					}
				} else {
					return;
				}

				env[key] = env[key].replace(new RegExp(`\\\${${match[1]}}`, 'g'), replacement);
			}
		});
	} catch (e) {
		// ignore
	}
}

export function pathReplace(fileName: string): string {
	fileName = fileName.replace('${workspaceFolder}', vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '');
	fileName = fileName.replace(/\${workspaceFolder:(.+?)}/g, (original, name) => {
		var folder = vscode.workspace.workspaceFolders!.find(folder => folder.name === name);
		return folder ? folder.uri.fsPath : original;
	});

	fileName = fileName.replace(/\$[{(]?([^})]+)[})]?/g, (original: string, v: string) => {
		if (env && v in env) {
			return env[v];
		}

		if (v.startsWith('env:')) {
			v = v.slice('env:'.length);
		}

		if (v in process.env) {
			return process.env[v] as string;
		}

		return '';
	});

	return fileName.replace(/$\([^)]+\)/g, '');
}

export function getWorkspaceRoot(file: string): string {
	if (path.isAbsolute(file)) {
		return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ?? path.dirname(file);
	}

	return vscode.workspace.workspaceFolders?.find(w => fs.existsSync(path.resolve(w.uri.fsPath, file)))?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? path.dirname(file);
}

export function resolvePath(fileName: string, base?: string): vscode.Uri {
	if (!fileName) {
		return vscode.Uri.file('');
	}

	fileName = pathReplace(fileName);
	if (fileName.match(/^\w{2,}:\//)) { // raw URI
		return vscode.Uri.parse(fileName);
	}

	if (!base) {
		base = getWorkspaceRoot(fileName);
	}

	// Relying on the uri accepting files without schemes:
	return vscode.Uri.file(path.resolve(base, fileName));
}

export type Environment = { [variable: string]: string };

export function replace(text: string, env: Environment) {
	return text.replace(/\$\((.+?)\)/, (original, variable) => ((variable in env) ? env[variable] : original));
}

var filemap: {[scheme: string]: (uri: vscode.Uri) => string} = {};

export function readFile(uri: vscode.Uri): string {
	if (uri.scheme in filemap) {
		return filemap[uri.scheme](uri);
	}

	console.error(`Unknown file ${uri.toString()}`);

	return '';
}

export function registerFileProvider(scheme: string, cb: (uri: vscode.Uri) => string) {
	filemap[scheme] = cb;
}

registerFileProvider('file', (uri: vscode.Uri) => {
	// check if this is a directory
	if (fs.statSync(uri.fsPath).isDirectory()) {
		return '';
	}

	return fs.readFileSync(uri.fsPath, {encoding: 'utf-8'})
});
