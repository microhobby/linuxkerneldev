import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class LinuxDevCmdProvider 
	implements vscode.TreeDataProvider<vscode.TreeItem> {

	constructor(private workspaceRoot: string | undefined) {}

	refresh(): void {
		console.log("refreshing...");
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
		/* first time */
		if (element === undefined) {
			/* check the network for Toradex devices */
			return this.getCmds();
		}

		return Promise.resolve([]);
	}

	private getCmds(): Promise<CmdOption[]> {
		return new Promise(resolve => {
			var cmds: CmdOption[] = [];
			const ctagsConfig = vscode.workspace.getConfiguration('ctags');

			// create the cmds
			// findDeviceTreeDoc
			cmds.push(new CmdOption("Device Tree Doc from compatible", "cmd0",
				vscode.TreeItemCollapsibleState.None,
				"",
				{
					command: "embeddedLinuxDev.findAndOpenDeviceTreeDoc",
					title: '',
					arguments: []
				}));

			// matchCompatible
			cmds.push(new CmdOption("Device Driver from compatible", "cmd1",
				vscode.TreeItemCollapsibleState.None,
				"",
				{
					command: "embeddedLinuxDev.findAndOpenDeviceTreeMatchDriver",
					title: '',
					arguments: []
				}));

			// dts/dtsi
			cmds.push(new CmdOption("ARM dts/dtsi from include", "cmd2",
				vscode.TreeItemCollapsibleState.None,
				"",
				{
					command: "embeddedLinuxDev.openArmDtsDtsi",
					title: '',
					arguments: []
				}));

			// arm64 dts/dtsi
			cmds.push(new CmdOption("ARM64 dts/dtsi from include", "cmd3",
				vscode.TreeItemCollapsibleState.None,
				"",
				{
					command: "embeddedLinuxDev.openArm64DtsDtsi",
					title: '',
					arguments: []
				}));

			// linux include
			cmds.push(new CmdOption("Linux Include from selected", "cmd4",
				vscode.TreeItemCollapsibleState.None,
				"",
				{
					command: "embeddedLinuxDev.openLinuxInclude",
					title: '',
					arguments: []
				}));

			// generate the ctags
			if (!ctagsConfig.get<boolean>('disable', false)) {
				cmds.push(new CmdOption("Generate CTags from project", "cmd5",
					vscode.TreeItemCollapsibleState.None,
					"",
					{
						command: "embeddedLinuxDev.regenerateCTags",
						title: '',
						arguments: []
					}));
			}

			// return
			resolve(cmds);
		});
	}
}

export class CmdOption extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public ip: string,
		public readonly collapsibleState: 
			vscode.TreeItemCollapsibleState,
		public desc: string,
		public readonly command?: vscode.Command
	) {
		super(label, collapsibleState);
	}
	
	// @ts-ignore
	get tooltip(): string {
		return `${this.label}`;
	}

	// @ts-ignore
	get description(): string {
		return `${this.desc}`;
	}

	iconPath = {
		light: path.join(
			__filename, 
			'..', 
			'..', 
			'res', 
			'boolean.svg'
		),
		dark: path.join(
			__filename, 
			'..', 
			'..', 
			'res', 
			'boolean.svg'
		)
	};

	contextValue = 'cmd';
}
