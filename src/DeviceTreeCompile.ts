import * as fs from 'fs';
import { PathLike } from 'fs';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as os from 'os';
import { CrossSpawn } from './CrossSpawn';

/**
 * Try to not use VSCode dependencies
 */

export interface DeviceTreeCompileDiagsnostics {
    file: PathLike
    line: number
    characterStart: number
    characterEnd: number
    cause: string
};

export class DeviceTreeCompile {
    private file: PathLike;
    private includePath: PathLike;
    private useDocker: boolean = false;
    private bindmount: PathLike = "";
    private rootpath: PathLike = "";
    private onErrorListeners:
        Array<(diagnostics: Array<DeviceTreeCompileDiagsnostics>) => void> = [];
    public Diagsnostics: Array<DeviceTreeCompileDiagsnostics> = [];

    constructor(
        file: PathLike,
        includePath: PathLike,
        useDocker?: boolean, bindmount?: PathLike)
	{
        this.file = file;
        this.includePath = includePath;

        if (useDocker != null)
            this.useDocker = useDocker;

        if (bindmount != null) {
            this.bindmount = bindmount;
            this.rootpath = `${bindmount.toString()}${path.sep}`;
        }

        // handle the relative paths in case of docker
        if (useDocker != null &&
            useDocker === true &&
            bindmount != null
        ) {
            this.bindmount = `${bindmount.toString()}${path.sep}`;
            this.includePath = this.includePath.toString()
                                    .replace(this.bindmount.toString(), "");
            
            this.file = this.file.toString()
                            .replace(this.bindmount.toString(), "");
            this.rootpath = "";
        }
    }

    public compile (): void {
        this._preprocess();
    }

    public onError (
        callback: (diagnostics: Array<DeviceTreeCompileDiagsnostics>) => void
    ): void {
        this.onErrorListeners.push(callback);
    }

    private _errorInIncludeFile (
        file: string,
        cause: string
    ): void {
        let diag: DeviceTreeCompileDiagsnostics | undefined = undefined;
        const fileName = path.basename(file);
        const dtsContentLines = fs.readFileSync(
            this.file,
            "utf8"
        ).toString().split("\n");

        // only check the first 20 lines
        for (let i = 0; i < 20; i++) {
            if (dtsContentLines[i].includes(fileName)) {
                diag = {
                    file: this.file,
                    line: i,
                    characterStart: 0,
                    characterEnd: dtsContentLines[i].length -1,
                    cause: `from included file '${fileName}' : ${cause}`
                };

                this.Diagsnostics.push(diag);
                break;
            }
        }

        // TODO: check also the includes of the file
        if (diag == null) {
            for (let i = 0; i < 20; i++) {
                if (dtsContentLines[i].includes("/dts")) {
                    diag = {
                        file: this.file,
                        line: i,
                        characterStart: 0,
                        characterEnd: dtsContentLines[i].length -1,
                        cause: `from included file '${fileName}' : ${cause}`
                    };
    
                    this.Diagsnostics.push(diag);
                    break;
                }
            }
        }
    }

    private _parseCppDiags (data: any, lineFixer: number): void {
        if (data.length > 0) {
            for (let i = 0; i < data.length; i++) {
                const obj = data[i];

                const diag: DeviceTreeCompileDiagsnostics = {
                    file: obj.locations[0].caret.file,
                    line: obj.locations[0].caret.line -lineFixer,
                    characterStart: obj.locations[0].caret.column -1,
                    characterEnd: obj.locations[0].finish.column -1,
                    cause: obj.message
                };

                this.Diagsnostics.push(diag);
            }
        }
    }

    private _parseDtcDiags (lines: string[], lineFixer: number): void {
        // check if this is a error
        const lastIndex = lines[lines.length -2];

        switch (lastIndex) {
            case "ERROR: Input tree has errors, aborting (use -f to force output)":
            {
                    const dataSlices: string[] = lines[0].split(":");
                    const lineCause = dataSlices[1].split(".");
                    const line = lineCause[0];
                    const cause = dataSlices[4].trim();
                    const file = dataSlices[0]; 

                    const baseFileName = path.basename(file.trim());
                    const thisBaseFileName = path.basename(this.file.toString());
    
                    if (
                        `${thisBaseFileName.endsWith(".dtsi") 
                            ? `.${thisBaseFileName}` : thisBaseFileName}` !==
                        baseFileName
                    ) {
                        this._errorInIncludeFile(file, cause);
                    } else {
                        const diag: DeviceTreeCompileDiagsnostics = {
                            file:
                                file,
                            line:
                                parseInt(line) - (lineFixer),
                            characterStart:
                                parseInt(lineCause[1].split("-")[0]) -1,
                            characterEnd:
                                parseInt(lineCause[1].split("-")[1]) -1,
                            cause:
                                cause
                        };
    
                        this.Diagsnostics.push(diag);
                    }
            }
            break;
            case "FATAL ERROR: Unable to parse input tree":
            case "FATAL ERROR: Syntax error parsing input tree":
            {
                const dataSlices: string[] = lines[0].split(":");
                const lineCause = dataSlices[2].split(" ");
                const line = lineCause.shift();
                const cause = lineCause.join(" ");
                const file = dataSlices[1];

                const baseFileName = path.basename(file.trim());
                const thisBaseFileName = path.basename(this.file.toString());
 
                if (
                    `${thisBaseFileName.endsWith(".dtsi") 
                        ? `.${thisBaseFileName}` : thisBaseFileName}` !==
                    baseFileName
                ) {
                    this._errorInIncludeFile(file, cause);
                } else {
                    const diag: DeviceTreeCompileDiagsnostics = {
                        file:
                            file,
                        line:
                            parseInt(line!.split(".")[0]) -lineFixer,
                        characterStart:
                            parseInt(line!.split(".")[1].split("-")[0]) -1,
                        characterEnd:
                            parseInt(line!.split(".")[1].split("-")[1]) -1,
                        cause:
                            cause
                    };

                    this.Diagsnostics.push(diag);
                }
            }
            break;
        }
    }

    private _switchStdErrStdOut (data: string, lineFixer: number): void {
        const dataString: string = data.toString();

        try {
            const jsonData = JSON.parse(dataString
                .replace("compilation terminated.", "").trim());
            // is valid json, so let get the data
            this._parseCppDiags(jsonData, lineFixer);
        } catch (error) {
            // is not a  valid json, check if is the dtc output
            const lines = dataString.split("\n");
            this._parseDtcDiags(lines, lineFixer);
        }

        for (let i = 0; i < this.onErrorListeners.length; i++) {
            this.onErrorListeners[i](this.Diagsnostics);
        }
    }

    private _attach (
        child: ChildProcessWithoutNullStreams,
        lineFixer: number,
        continueChain?: () => void,
    ): void {
        child.on("error", err => {
            console.log("Child Error>")
            console.error(err.message);
        });

        child.on("message", message => {
            console.log("Child Message>");
            console.log(message);
        });

        child.on("exit", code => {
            if (code === 0) {
                if (continueChain)
                    continueChain();
            } else {
                console
                    .log(`child has exited with error code ${code}`);
            }
        });

        // docker
        child.stdout.on('data', (data: string) => {
			this._switchStdErrStdOut(data, lineFixer);
		});

        // native
		child.stderr.on('data', (data: any) => {
            this._switchStdErrStdOut(data, lineFixer);
		});
    }

    private _preprocess (): void {
        let dotFilename = 
            path.basename(this.file.toString());
        const dotFileNamePath =
            path.dirname(this.file.toString());
        let lineFixer = 1;

        // we need to add the /dts-v1/
        if (dotFilename.endsWith("dtsi")) {
            const dtsiContent = fs.readFileSync(
                path.join(
                    this.useDocker ? this.bindmount.toString() : "",
                    dotFileNamePath,
                    `${dotFilename}`
                ),
                "utf8"
            ).toString();

            let dtsiInjected = '/dts-v1/;\n';
            dtsiInjected = dtsiInjected.concat(dtsiContent); 

            fs.writeFileSync(
                path.join(
                    this.useDocker ? this.bindmount.toString() : "",
                    dotFileNamePath,
                    `.${dotFilename}`
                ),
                dtsiInjected
            );

            dotFilename = `.${dotFilename}`;
            lineFixer = 2;
        }

        const child = CrossSpawn.spawn(
            "cpp",
            [
                "-fdiagnostics-format=json",
                "-nostdinc",
                `-I ${this.includePath.toString()}`,
                `-I ${this.rootpath}arch`,
                `-I ${this.rootpath}scripts/dtc/include-prefixes`,
                // zephyr includes
                `-I ${this.rootpath}dts`,
                `-I ${this.rootpath}dts/arc`,
                `-I ${this.rootpath}dts/arm`,
                `-I ${this.rootpath}dts/arm64`,
                `-I ${this.rootpath}dts/bindings`,
                `-I ${this.rootpath}dts/common`,
                `-I ${this.rootpath}dts/nios2`,
                `-I ${this.rootpath}dts/posix`,
                `-I ${this.rootpath}dts/riscv`,
                `-I ${this.rootpath}dts/sparc`,
                `-I ${this.rootpath}dts/x86`,
                `-I ${this.rootpath}dts/xtensa`,
                // end zephyr includes
                "-undef",
                "-x assembler-with-cpp",
                `${path.join(dotFileNamePath, `${dotFilename}`)}`,
                `${path.join(dotFileNamePath, `.${dotFilename}.pre`)}`
            ],
            this.useDocker,
            this.bindmount
        );

        this._attach(child, lineFixer, this._compile);
    }

    private _compile = (): void => {
        let dotFilename = 
            path.basename(this.file.toString());
        const dotFileNamePath =
            path.dirname(this.file.toString());
        let lineFixer = 1;

        if (dotFilename.endsWith("dtsi")) {
            dotFilename = `.${dotFilename}`;
            lineFixer = 2;
        }

        const dtcChild = CrossSpawn.spawn(
            "dtc",
            [
                "-@",
                "-I dts",
                `${path.join(dotFileNamePath, `.${dotFilename}.pre`)}`,
                `-o ${path.join(dotFileNamePath, `.${dotFilename}.pre.yaml`)}`,
                `-O yaml`
            ],
            this.useDocker,
            this.bindmount
        );

        this._attach(dtcChild, lineFixer);
    };
}
