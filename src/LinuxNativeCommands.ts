import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';

export class LinuxNativeCommands {

	private insider:string = "code";

	constructor()
	{
		// check if we are runnin on vs code insiders
		if (vscode.version.indexOf("insider") !== -1) {
			this.insider = "code-insiders";
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
			child = spawn(scriptPath, [pathSrc!, selected, this.insider]);
	
			child.stdout.on('data', (data: string) => {
				console.log(`stdout: ${data}`);
				res(data.toString());
			});

			child.stderr.on('data', (data: string) => {
				console.error(`stderr: ${data}`);
				rej();
			});
			
			child.on('close', (code: any) => {
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
			child = spawn(scriptPath, [pathSrc!, selected, this.insider]);
		} else {
			child = spawn("pwsh", [
				"-NoProfile", scriptPath, pathSrc!, selected, this.insider
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
}
