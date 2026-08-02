/*
 * DeviceTreeLinkProvider
 *
 * Provides DocumentLinks for device tree compatible strings, linking to:
 * - Driver implementation files in drivers/
 * - Documentation in Documentation/devicetree/bindings/
 */
import * as vscode from 'vscode';
import { LinuxNativeCommands } from './LinuxNativeCommands';
import { CompatibleMatchCache } from './CompatibleMatchCache';

export class DeviceTreeLinkProvider implements vscode.DocumentLinkProvider {
    private nativeCmdHelper: LinuxNativeCommands;

    constructor() {
        this.nativeCmdHelper = new LinuxNativeCommands();
    }

    async provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentLink[]> {
        const links: vscode.DocumentLink[] = [];

        if (!vscode.workspace.rootPath) {
            return links;
        }

        // Parse document for compatible strings
        const compatibleMatches = this.findCompatibleStrings(document);

        for (const match of compatibleMatches) {
            // Find driver implementation links
            const driverLinks = await this.createDriverLinks(
                match.value,
                match.range,
                vscode.workspace.rootPath
            );
            links.push(...driverLinks);

            // Find documentation links
            const docLinks = await this.createDocumentationLinks(
                match.value,
                match.range,
                vscode.workspace.rootPath
            );
            links.push(...docLinks);
        }

        return links;
    }

    /**
     * Find all compatible string values in the document
     */
    private findCompatibleStrings(document: vscode.TextDocument): Array<{ value: string, range: vscode.Range }> {
        const matches: Array<{ value: string, range: vscode.Range }> = [];
        const text = document.getText();

        // Match the whole compatible property value list up to the terminating ';', then extract all quoted strings.
        const propRegex = /compatible\s*=\s*([^;]*);/g;
        let propMatch: RegExpExecArray | null;

        while ((propMatch = propRegex.exec(text)) !== null) {
            const valuesPart = propMatch[1];
            const valuesPartOffset = propMatch.index + propMatch[0].indexOf(valuesPart);

            const strRegex = /"([^"]+)"/g;
            let strMatch: RegExpExecArray | null;
            while ((strMatch = strRegex.exec(valuesPart)) !== null) {
                const value = strMatch[1];
                const startOffset = valuesPartOffset + strMatch.index;
                const startPos = document.positionAt(startOffset);
                const endPos = document.positionAt(startOffset + strMatch[0].length);
                matches.push({ value, range: new vscode.Range(startPos, endPos) });
            }
        }

        return matches;
    }

    /**
     * Create links to driver implementation files
     */
    private async createDriverLinks(
        compatible: string,
        range: vscode.Range,
        rootPath: string
    ): Promise<vscode.DocumentLink[]> {
        const links: vscode.DocumentLink[] = [];

        // Check cache first
        const cachedMatch = CompatibleMatchCache.Cache.find(
            c => c.compatible === compatible
        );

        if (cachedMatch && !cachedMatch.notFound) {
            const link = new vscode.DocumentLink(range, cachedMatch.file);
            link.tooltip = cachedMatch.file.fsPath;
            links.push(link);
            return links;
        }

        if (cachedMatch?.notFound) {
            // Already searched and not found
            return links;
        }

        // Search for driver match
        try {
            const fileMatch = await this.nativeCmdHelper.asyncFindDeviceTreeMathc(
                compatible,
                rootPath
            );

            if (fileMatch.trim() !== "") {
                // Parse grep output: filepath:linenumber:content
                const grepSlices = fileMatch.split(":");
                if (grepSlices.length >= 2) {
                    const filePath = grepSlices[0];
                    const lineNumber = grepSlices[1];
                    const dst = vscode.Uri.file(filePath).with({ fragment: lineNumber });

                    const link = new vscode.DocumentLink(range, dst);
                    link.tooltip = `${filePath} (driver implementation)`;
                    links.push(link);

                    // Cache the result
                    CompatibleMatchCache.Cache.push({
                        compatible: compatible,
                        file: dst,
                        notFound: false
                    });
                } else {
                    // Mark as not found
                    CompatibleMatchCache.Cache.push({
                        compatible: compatible,
                        file: vscode.Uri.file(""),
                        notFound: true
                    });
                }
            } else {
                // Mark as not found
                CompatibleMatchCache.Cache.push({
                    compatible: compatible,
                    file: vscode.Uri.file(""),
                    notFound: true
                });
            }
        } catch (error) {
            console.error(`Error finding driver match for "${compatible}": ${error}`);
        }

        return links;
    }

    /**
     * Create links to documentation files
     */
    private async createDocumentationLinks(
        compatible: string,
        range: vscode.Range,
        rootPath: string
    ): Promise<vscode.DocumentLink[]> {
        const links: vscode.DocumentLink[] = [];

        // Check cache first
        const cachedDocMatch = CompatibleMatchCache.DocCache.find(
            c => c.compatible === compatible
        );

        if (cachedDocMatch && !cachedDocMatch.notFound) {
            // Create links for all cached documentation files
            for (const file of cachedDocMatch.files) {
                const link = new vscode.DocumentLink(range, file);
                link.tooltip = `${file.fsPath} (documentation)`;
                links.push(link);
            }
            return links;
        }

        if (cachedDocMatch?.notFound) {
            // Already searched and not found
            return links;
        }

        // Search for documentation
        try {
            const fileMatch = await this.nativeCmdHelper.asyncFindDeviceTreeDoc(
                compatible,
                rootPath
            );

            const docFiles: vscode.Uri[] = [];

            if (fileMatch.trim() !== "") {
                // Parse grep output - can be multiple files
                // Format: filepath:content or just filepath
                const lines = fileMatch.trim().split("\n");

                for (const line of lines) {
                    if (line.trim() === "") continue;

                    const colonIndex = line.indexOf(":");
                    const filePath = colonIndex > 0 ? line.substring(0, colonIndex) : line;

                    if (filePath && filePath.trim() !== "") {
                        const dst = vscode.Uri.file(filePath.trim());

                        // Avoid duplicate links
                        if (!links.find(l => l.target?.fsPath === dst.fsPath)) {
                            const link = new vscode.DocumentLink(range, dst);
                            link.tooltip = `${filePath.trim()} (documentation)`;
                            links.push(link);
                            docFiles.push(dst);
                        }
                    }
                }

                // Cache the results
                if (docFiles.length > 0) {
                    CompatibleMatchCache.DocCache.push({
                        compatible: compatible,
                        files: docFiles,
                        notFound: false
                    });
                } else {
                    CompatibleMatchCache.DocCache.push({
                        compatible: compatible,
                        files: [],
                        notFound: true
                    });
                }
            } else {
                // Mark as not found
                CompatibleMatchCache.DocCache.push({
                    compatible: compatible,
                    files: [],
                    notFound: true
                });
            }
        } catch (error) {
            console.error(`Error finding documentation for "${compatible}": ${error}`);
        }

        return links;
    }
}
