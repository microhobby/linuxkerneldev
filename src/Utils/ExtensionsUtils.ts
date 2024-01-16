/* eslint-disable @typescript-eslint/no-extraneous-class */
import * as vscode from "vscode";
import {
    OUTPUT_CHANNEL_NAME, OUT_ERR, OUT_WARN, PUBLISHER_NAME
} from "./Consts";
import { PathLike } from "fs";

type ProgressCallback = (resolve?: any, progress?: vscode.Progress<{
    message?: string | undefined;
    increment?: number | undefined;
}>) => Promise<void>;

var _termID = 0;

/* static class */
export class ExtensionUtils {
    static Global = {
        CONTEXT: {}
    };

    static outputChannel: vscode.OutputChannel =
    vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

    static statusBarProgressBar: vscode.StatusBarItem =
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

    static getTimeStampFormated (): string {
        const date = new Date();
        const month = `0${(date.getMonth() + 1)}`.slice(-2);
        const day = `0${(date.getDate())}`.slice(-2);
        const hours = `0${(date.getHours())}`.slice(-2);
        const minutes = `0${(date.getMinutes())}`.slice(-2);
        const seconds = `0${(date.getSeconds())}`.slice(-2);
        const milliseconds = `0${(date.getMilliseconds())}`.slice(-3);

        return `${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
    }

    static writeln (msg: string, show: boolean = false): void {
        if (msg.trim() !== "") {
            const timeformatted = `[${ExtensionUtils.getTimeStampFormated()}] `;
            ExtensionUtils.outputChannel.appendLine(timeformatted + msg);
            console.log(timeformatted + msg);

            if (show) {
                ExtensionUtils.outputChannel.show(true);
            }
        }
    }

    static showStatusBarLoading (title: string): void {
        this.statusBarProgressBar.text = `$(loading~spin) ${title}`;
        this.statusBarProgressBar.show();
    }

    static hideStatusBar (): void {
        this.statusBarProgressBar.text = ``;
        this.statusBarProgressBar.hide();
    }

    static hideStatusBarLoading = ExtensionUtils.hideStatusBar;

    static showStatusBarError (message: string): void {
        this.statusBarProgressBar.text = `$(error) ${message}`;
        this.statusBarProgressBar.show();
    }

    static hideStatusBarError = ExtensionUtils.hideStatusBar;

    static showStatusBarWarning (message: string): void {
        this.statusBarProgressBar.text = `$(warning) ${message}`;
        this.statusBarProgressBar.show();
    }

    static hideStatusBarWarning = ExtensionUtils.hideStatusBar;

    static showStatusBarOk (message: string): void {
        this.statusBarProgressBar.text = `$(pass-filled) ${message}`;
        this.statusBarProgressBar.show();
    }

    static hideStatusBarOk = ExtensionUtils.hideStatusBar;

    static showProgress (title: string, msg: string,
        resFunc: ProgressCallback, cancellable: boolean = false): void {
        void vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: title,
            cancellable: cancellable
        }, async progressNotification => {
            progressNotification.report({ message: msg });

            return await new Promise(resolve => {
                void resFunc(resolve, progressNotification);
            });
        });
    }

    static showError (message: string): void {
        ExtensionUtils.writeln(`${OUT_ERR} ${message}`, true);
        void vscode.window.showErrorMessage(message);
    }

    static showSuccess (message: string): void {
        ExtensionUtils.writeln(message, true);
        void vscode.window.showInformationMessage(message);
    }

    static showWarning (message: string, modal?: boolean): void {
        ExtensionUtils.writeln(`${OUT_WARN} ${message}`, true);
        void vscode.window.showWarningMessage(message, {
            modal: modal
        });
    }

    static createTerminal (
        name: string,
        shellArgs: string[]
    ): vscode.Terminal {
        var termOps: vscode.TerminalOptions = { shellArgs: [] };
        termOps.name = name;

        const term = vscode.window.createTerminal(termOps);
        term.sendText(
            `${shellArgs.join(" ")}`
        );
        term.show();

        return term;
    }

    static async showInput (
        title: string,
        placeHolder: string = "",
        password: boolean = false
    ): Promise<string> {
        return await new Promise(resolve => {
            const inpRet = vscode.window.showInputBox({
                ignoreFocusOut: true,
                placeHolder: placeHolder,
                title: title,
                password: password
            });

            if (inpRet == null) {
                throw new Error(`${title} can't be empty`);
            }

            resolve(inpRet);
        });
    }

    static async showInputList (
        list: string[],
        placeHolder: string
    ): Promise<string | undefined> {
        return await vscode.window.showQuickPick(list, {
            ignoreFocusOut: true,
            placeHolder: placeHolder
        });
    }

    static async showInputItem<T> (
        itemList: T[],
        placeHolder: string = ""
    ): Promise<T | undefined> {
        var item: T;
        return await new Promise(resolve => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = (itemList as unknown as vscode.QuickPickItem[]);
            quickPick.canSelectMany = false;
            quickPick.ignoreFocusOut = true;
            quickPick.placeholder = placeHolder;
            quickPick.onDidHide(() => {
                quickPick.dispose();
                if (item == null) { resolve(undefined); }
            });
            quickPick.onDidAccept(() => {
                item = quickPick.activeItems[0] as unknown as T;
                quickPick.hide();
                resolve(item as unknown as T);
            });
            quickPick.show();
        });
    }

    static async showMultiInputItem<T> (
        itemList: T[],
        placeHolder: string = ""
    ): Promise<T[] | undefined> {
        var items: T[];
        return await new Promise(resolve => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = (itemList as unknown as vscode.QuickPickItem[]);
            quickPick.canSelectMany = true;
            quickPick.ignoreFocusOut = true;
            quickPick.placeholder = placeHolder;
            quickPick.onDidHide(() => {
                quickPick.dispose();
                if (items == null) { resolve(undefined); }
            });
            quickPick.onDidAccept(() => {
                items = quickPick.selectedItems as unknown as T[];
                quickPick.hide();
                resolve(items as unknown as T[]);
            });
            quickPick.show();
        });
    }

    static async showFolderChooser (): Promise<vscode.Uri[] | undefined> {
        return await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: "Select Folder"
        });
    }

    static async loadWorkspace (location: PathLike): Promise<void> {
        return await vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(location.toString()),
            false
        );
    }

    static async showYesNoInput (ask: string): Promise<boolean> {
        return await new Promise(resolve => {
            void vscode.window.showInformationMessage(ask, "Yes", "No")
                .then(answer => {
                    if (answer === "Yes") {
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                });
        });
    }

    static async runOnTerminal (cmd: string): Promise<boolean> {
        _termID++;
        return await new Promise(resolve => {
            const term = vscode.window
                .createTerminal({
                    name: `${PUBLISHER_NAME} cmd ${_termID}`,
                    shellPath: "/bin/bash",
                    // eslint-disable-next-line spellcheck/spell-checker
                    shellArgs: ["--norc", "--noprofile"],
                    env: {
                        PS1: ""
                    },
                    message: `Running ${PUBLISHER_NAME} cmd ${_termID}`
                });
            term.show();
            term.sendText(`${cmd} ; exit`, true);

            const termDispose = vscode.window.onDidCloseTerminal(term => {
                if (term.name === `${PUBLISHER_NAME} cmd ${_termID}`) {
                    termDispose.dispose();
                    resolve(term.exitStatus?.code === 0);
                }
            });
        });
    }

    static runOnAndReturnTerminalRef (
        title: string,
        cmd: string
    ): vscode.Terminal {
        const term = vscode.window
            .createTerminal({
                name: `${title}`,
                shellPath: "/bin/bash",
                // eslint-disable-next-line spellcheck/spell-checker
                shellArgs: ["--norc", "--noprofile"],
                env: {
                    PS1: ""
                },
                message: `Running ${PUBLISHER_NAME} cmd ${_termID}`
            });
        term.show();
        term.sendText(`${cmd} ; exit`, true);

        return term;
    }

    static async runCommand (cmd: string, ...args: any[]): Promise<void> {
        return await vscode.commands.executeCommand(cmd, ...args);
    }

    static getInstallationPath (): string | undefined {
        return vscode.extensions
            .getExtension(PUBLISHER_NAME)
            ?.extensionPath;
    }

    static async saveGlobalState<T> (obj: T): Promise<void> {
        const context =
            (ExtensionUtils.Global.CONTEXT as vscode.ExtensionContext);

        await context.globalState.update(
            PUBLISHER_NAME,
            obj
        );
    }

    static async loadGlobalState<T> (): Promise<T | undefined> {
        const context =
            (ExtensionUtils.Global.CONTEXT as vscode.ExtensionContext);

        return await context.globalState.get(
            PUBLISHER_NAME
        );
    }

    static async saveSecret (key: string, value: string): Promise<void> {
        const context = (this.Global.CONTEXT as vscode.ExtensionContext);
        await context.secrets.store(key, value);
    }

    static async getSecret (key: string): Promise<string | undefined> {
        const context = (this.Global.CONTEXT as vscode.ExtensionContext);
        return await context.secrets.get(key);
    }

    static async delay(ms: number): Promise<void> {
        return new Promise( resolve => setTimeout(resolve, ms) );
    }
}
