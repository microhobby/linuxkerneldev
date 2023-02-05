import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';
import * as utils from './util';
import { ExtensionUtils } from './Utils/ExtensionsUtils';

export class LinuxNativeCommands {

	private codeCmd:string = "code";
	private _serialTerminal: vscode.Terminal = null;

	constructor()
	{
		// check if we are runnin on vs code insiders
		if (vscode.version.indexOf("insider") !== -1) {
			this.codeCmd = "code-insiders";
		// code-server ??
		} else if (vscode.env.appHost.includes("server-distro")) {
			this.codeCmd = "code-server";
		}
	}

	private async asyncCreateScriptSpawn (
		name: string,
		selected: string,
		pathSrc?: string
	): Promise<string> {
		return new Promise<string>((res, rej) => {
			let scriptPath: string = path.join(__filename,
				"..",
				"..",
				"scripts",
				name
			);

			let child: any;
			child = spawn(scriptPath, [pathSrc!, selected, this.codeCmd]);

			child.stdout.on('data', (data: string) => {
				console.log(`stdout: ${data}`);
				res(data.toString());
			});

			child.stderr.on('data', (data: string) => {
				console.error(`stderr: ${data}`);
				rej();
			});

			child.on('close', (code: any) => {
				if (code !== 0)
					rej();
			});
		});
	}

	private createScriptSpawn(name: string, selected: string,
		pathSrc?: string, onStdout?: Function, onSterr?: Function,
		osPlatform?: string
	): void
	{
		if (selected === "") {
			if (onSterr !== undefined) {
				onSterr("🤔 Are you sure this selection is an include or string?");
			}
			return;
		}


		let scriptPath: string = path.join(__filename,
			"..",
			"..",
			"scripts",
			name
		);

		let child: any;

		if (osPlatform !== "win32") {
			child = spawn(scriptPath, [pathSrc!, selected, this.codeCmd]);
		} else {
			child = spawn("pwsh", [
				"-NoProfile", scriptPath, pathSrc!, selected, this.codeCmd
			],{
				shell: false,
				windowsHide: true,
				detached: true
			});
		}

		child.stdout.on('data', (data: string) => {
			console.log(`stdout: ${data}`);
			if (onStdout !== undefined) {
				onStdout(`${data}`);
			}
		});

		child.stderr.on('data', (data: string) => {
			console.error(`stderr: ${data}`);
			if (onSterr !== undefined) {
				onSterr(`${data}`);
			}
		});

		child.on('close', (code: any) => {
			console.log(`child process exited with code ${code}`);
		});
	}

	findAndOpenDeviceTreeDoc(selected: string, pathSrc?: string,
		onStdout?: Function, onSterr?: Function): void
	{
		// resolve and run
		this.createScriptSpawn("findDeviceTreeDoc.sh", selected,
			pathSrc, onStdout, onSterr);
	}

	findDeviceTreeMatch(selected: string, pathSrc?: string,
		onStdout?: Function, onSterr?: Function): void
	{
		// resolve and run
		this.createScriptSpawn("findDeviceTreeMatch.sh", selected,
			pathSrc, onStdout, onSterr);
	}

	async asyncFindDeviceTreeMathc (
		selected: string, pathSrc?: string
	): Promise<string> {
		return this.asyncCreateScriptSpawn(
			"findDeviceTreeMatchReturnString.sh",
			selected,
			pathSrc
		);
	}

	async asyncFindDeviceTreeDoc(
		selected: string,
		pathSrc?: string
	): Promise<string> {
		return this.asyncCreateScriptSpawn(
			"findDeviceTreeMatchDocReturnString.sh",
			selected,
			pathSrc
		);
	}

	findArmDts(selected: string, pathSrc?: string,
		onStdout?: Function, onSterr?: Function): void
	{
		// resolve and run
		this.createScriptSpawn("findArmDts.sh", selected,
			pathSrc, onStdout, onSterr);
	}

	findArm64Dts(selected: string, pathSrc?: string,
		onStdout?: Function, onSterr?: Function): void
	{
		// resolve and run
		this.createScriptSpawn("findArm64Dts.sh", selected,
			pathSrc, onStdout, onSterr);
	}

	findLinuxInclude(selected: string, pathSrc?: string,
		onStdout?: Function, onSterr?: Function): void
	{
		// resolve and run
		this.createScriptSpawn("findLinuxInclude.sh", selected,
			pathSrc, onStdout, onSterr);
	}

	checkDeps(pathSrc?: string, onStdout?: Function,
		onSterr?: Function): void
	{
		// resolve and run
		const config = vscode.workspace.getConfiguration('kerneldev');
		const useDocker = config.get<boolean>('useDocker');

		if (!useDocker) {
			this.createScriptSpawn("checkDeps.sh", "null", pathSrc,
				onStdout, onSterr);
		} else {
			if (os.platform() === "win32") {
				this.createScriptSpawn(
					"checkDepsContainer.ps1",
					"null",
					pathSrc,
					onStdout,
					onSterr,
					os.platform()
				);
			} else {
				this.createScriptSpawn(
					"checkDepsContainer.sh",
					"null",
					pathSrc,
					onStdout,
					onSterr,
					os.platform()
				);
			}
		}
	}

	private _checkForSetting (setting: string): string
	{
		const kerneldevConfig = vscode.workspace.getConfiguration('kerneldev');

		if (kerneldevConfig.has(setting)) {
			return kerneldevConfig.get<string>(setting);
		} else {
			vscode.window.showErrorMessage(`Setting ${setting} not set`);
			throw new Error("Setting not set");
		}
	}

	async startAgentProxy(): Promise<boolean>
	{
		try {
			const portKgdb = this._checkForSetting("kgdb_port");
			const portSerial = this._checkForSetting("serial_port");
			const serialDev = this._checkForSetting("serial_dev");
			const serialBaudRate = this._checkForSetting("serial_baudRate");

			return await new Promise(resolve => {
				let scriptPath: string = path.join(__filename,
					"..",
					"..",
					"scripts",
					"agentProxy.sh"
				);

				const child = spawn(scriptPath, [
					portSerial,
					portKgdb,
					serialDev,
					serialBaudRate
				]);

				child.stdout.on('data', (data: string) => {
					console.log(`stdout: ${data}`);
					utils.log(data.toString());

					// connect to serial
					this._serialTerminal =
						ExtensionUtils.runOnAndReturnTerminalRef(
							"Serial Console",
							`telnet localhost ${portSerial}`
						);

					resolve(true);
				});

				child.stderr.on('data', (data: string) => {
					console.error(`stderr: ${data}`);
					utils.log(data.toString());
				});

				child.on('close', (code: any) => {
					this._serialTerminal = null;
					console.log(`child process ${scriptPath} exited with code ${code}`);
					resolve(false);
				});
			});
		} catch (e) {
			return false;
		}
	}

	async breakKernelToDebug(): Promise<boolean>
	{
		const bySysrq =  vscode.workspace
			.getConfiguration('kerneldev').get<boolean>("breakBySysrq");
		
		try {
			if (!bySysrq) {
				const sshIp = this._checkForSetting("ssh_ip");
				const sshPsswd = this._checkForSetting("ssh_psswd");
				const sshLogin = this._checkForSetting("ssh_login");

				let scriptPath: string = path.join(__filename,
					"..",
					"..",
					"scripts",
					"break.sh"
				);

				const child = spawn(scriptPath, [
					sshPsswd,
					sshLogin,
					sshIp
				]);

				child.stdout.on('data', (data: string) => {
					console.log(`stdout: ${data}`);
					utils.log(data.toString());
				});

				child.stderr.on('data', (data: string) => {
					console.error(`stderr: ${data}`);
					utils.log(data.toString());
				});

				child.on('close', (code: any) => {
					console.log(`child process ${scriptPath} exited with code ${code}`);
				});
			} else {
				await ExtensionUtils.delay(500);

				if (this._serialTerminal != null) {
					// send the telnet scape char
					this._serialTerminal.sendText("\x1D");
					await ExtensionUtils.delay(100);
					this._serialTerminal.sendText(`send break\n`);
					await ExtensionUtils.delay(100);
					this._serialTerminal.sendText(`g\n`);
				}
			}

			return true;
		} catch (e) {
			return false;
		}
	}

	generateBitBakeCtags(
		pathSrc?: string,
		onStdout?: Function, onSterr?: Function
	): void {
		// resolve and run
		this.createScriptSpawn(
			"generateBitBakeCtags.sh", 
			"null",
			pathSrc, onStdout, onSterr
		);
	}
}
