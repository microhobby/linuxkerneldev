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

        if (bindmount != null)
            this.bindmount = bindmount;

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

    private _parseCppDiags (data: any, lineFixer: number): void {
        if (data.length > 0) {
            for (let i = 0; i < data.length; i++) {
                const obj = data[i];

                const diag: DeviceTreeCompileDiagsnostics = {
                    file: obj.locations[0].caret.file,
                    line: obj.locations[0].caret.line -lineFixer,
                    characterStart: obj.locations[0].caret.column,
                    characterEnd: obj.locations[0].finish.column,
                    cause: obj.message
                };

                this.Diagsnostics.push(diag);
            }
        }
    }

    private _parseDtcDiags (lines: string[], lineFixer: number): void {
        for (let i = 0; i < lines.length; i++) {
            const dataSlices: string[] = lines[i].split(":");
            // console.log(lines[i]);

            if (dataSlices[0].startsWith("Error")) {
                const lineCause = dataSlices[2].split(" ");
                const line = lineCause.shift();
                const cause = lineCause.join(" ");

                const diag: DeviceTreeCompileDiagsnostics = {
                    file: dataSlices[1],
                    line: parseInt(line!.split(".")[0]) -lineFixer,
                    characterStart: parseInt(line!.split(".")[1].split("-")[0]),
                    characterEnd: parseInt(line!.split(".")[1].split("-")[1]),
                    cause: cause
                };

                this.Diagsnostics.push(diag);
            }
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
                path.join(dotFileNamePath, `${dotFilename}`),
                "utf8"
            ).toString();

            let dtsiInjected = '/dts-v1/;\n';
            dtsiInjected = dtsiInjected.concat(dtsiContent); 

            fs.writeFileSync(
                path.join(dotFileNamePath, `.${dotFilename}`),
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
                "-I arch",
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
