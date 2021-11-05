import * as vscode from 'vscode';
import * as path from 'path';
import { DeviceTreeCompile } from './DeviceTreeCompile';

/**
 * This is VS Code dependent
 */

export class DeviceTreeVSCodeDiags {
    public static compile (
        fileDocument: vscode.Uri,
        diagColletion: vscode.DiagnosticCollection
    ): void {
        const diags: vscode.Diagnostic[] = [];
        const configKerneldev = vscode.workspace.getConfiguration('kerneldev');
		const useDocker = configKerneldev.get<boolean>('useDocker');
        const experimental = configKerneldev.get<any>('experimental');

        if (experimental.newDtsEngine) {
            // TODO: here we are harding coding the include path
            let dtc = new DeviceTreeCompile(
                fileDocument.fsPath,
                path.join(vscode.workspace.rootPath!, "include"),
                useDocker,
                vscode.workspace.rootPath!
            );
            
            // cleanup
            diagColletion.set(fileDocument, diags);

            dtc.onError(errors => {
                errors.forEach(error => {
                    diags.push(
                        new vscode.Diagnostic(
                            new vscode.Range(
                                new vscode.Position(
                                    error.line,
                                    error.characterStart
                                ),
                                new vscode.Position(
                                    error.line,
                                    error.characterEnd
                                )
                            ),
                            error.cause,
                            vscode.DiagnosticSeverity.Error
                        )
                    );
                });

                diagColletion.set(fileDocument, diags);
            });

            dtc.compile();
        }
    }
};
