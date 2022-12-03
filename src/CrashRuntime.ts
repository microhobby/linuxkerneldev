import { EventEmitter } from "events";
import { CrashUtility } from "./CrashUtility";

export interface IRuntimeBreakpoint {
    id: number;
    file: string;
    line: number;
    symbol: string;
    verified: boolean;
}

export class CrashRuntime extends EventEmitter {
    // maps from sourceFile to array of IRuntimeBreakpoint
    public readonly BreakPoints = new Array<IRuntimeBreakpoint>();
    private _crash: CrashUtility | undefined = undefined;

    // no need useless constructor

    public async start (
        crash: string, vmlinux: string, vmcore: string
    ): Promise<void> {
        this._crash = new CrashUtility(
            crash,
            vmlinux,
            vmcore
        );

        return await new Promise(resolve => {
            this._crash!.getCrashStackTrace().then((res) => {
                for (const bt of res) {
                    this.BreakPoints.push({
                        file: bt.AtFile,
                        line: bt.AtLine,
                        symbol: bt.Symbol,
                        verified: false,
                        id: 0
                    })
                }

                resolve();
                this.sendEvent("stopOnEntry");
            }, console.error);
        });
    }

    public stop (): void {
        this._crash?.destruct();
    }

    private sendEvent (event: string, ...args: any[]): void {
        setTimeout(() => {
            this.emit(event, ...args);
        }, 0);
    }
}
