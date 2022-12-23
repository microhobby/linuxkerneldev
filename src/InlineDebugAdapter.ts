import * as vscode from 'vscode';
import * as path from 'fs';
import {
    WorkspaceFolder,
    DebugConfiguration,
    ProviderResult,
    CancellationToken
} from 'vscode';
import { CrashDebugSession } from './CrashDebugSession';

class InlineDebugAdapterFactory implements
vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor (
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
            new CrashDebugSession()
        );
    }
}

export class InlineDebugAdapter implements
    vscode.DebugConfigurationProvider,
    vscode.DebugAdapterDescriptorFactory {
    RegDisposables: vscode.Disposable[] = [];

    public static Activate (
        context: vscode.ExtensionContext,
        factory?: vscode.DebugAdapterDescriptorFactory
    ): void {
        const provider = new InlineDebugAdapter();
        context.subscriptions.push(
            vscode.debug.registerDebugConfigurationProvider(
                "crash", provider
            )
        );

        if (factory == null) {
            factory = new InlineDebugAdapterFactory();
        }

        context.subscriptions.push(
            vscode.debug.registerDebugAdapterDescriptorFactory(
                "crash", factory
            )
        );
    }

    // implements DebugConfigurationProvider
    resolveDebugConfiguration (
        folder: WorkspaceFolder | undefined,
        config: DebugConfiguration,
        token?: CancellationToken
    ): ProviderResult<DebugConfiguration> {
        if (config.crash == null) {
            return vscode.window
                .showInformationMessage("Crash cannot be empty")
                .then(_ => {
                    return undefined; // abort launch
                });
        } else if (!path.existsSync(config.crash)) {
            return vscode.window
                .showErrorMessage("Crash utility binary file does not found")
                .then(_ => {
                    return undefined; // abort launch
                });
        }

        if (config.vmcore == null) {
            return vscode.window
                .showInformationMessage("vmcore cannot be empty")
                .then(_ => {
                    return undefined; // abort launch
                });
        } else if (!path.existsSync(config.vmcore)) {
            return vscode.window
                .showErrorMessage("vmcore crash file does not found")
                .then(_ => {
                    return undefined; // abort launch
                });
        }

        if (config.vmlinux == null) {
            return vscode.window
                .showInformationMessage("vmlinux cannot be empty")
                .then(_ => {
                    return undefined; // abort launch
                });
        } else if (!path.existsSync(config.vmlinux)) {
            return vscode.window
                .showErrorMessage("vmlinux file does not found")
                .then(_ => {
                    return undefined; // abort launch
                });
        }

        return config;
    }

    // implements DebugAdapterDescriptorFactory
    createDebugAdapterDescriptor (
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        throw new Error('Method not implemented.');
    }
}
