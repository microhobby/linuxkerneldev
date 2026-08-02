import { exec, ChildProcess } from "child_process";
import { PathLike } from "fs";
import { clearInterval, setInterval, setTimeout } from "timers";
import { StackTraceItem } from "./StackTraceItem";
import {
    STDOUT_OK_MAX_ATTEMPTS
} from "./Utils/Consts";

export class CrashUtility {
    private readonly _crashPs: ChildProcess;

    constructor (
        execPath: PathLike,
        vmlinuxPath: PathLike,
        vmcorePath: PathLike,
        crashArgs: string
    ) {
        // eslint-disable-next-line max-len
        this._crashPs = exec(`${execPath.toString()} ${vmlinuxPath.toString()} ${vmcorePath.toString()} ${crashArgs}`);
        this._crashPs.on("exit", () => {
            console.log("crash utility has been closed");
        });
    }

    public destruct (): void {
        this._crashPs.kill();
    }

    private async _stdinOk (): Promise<boolean> {
        let attempts = 0;
        let intHandle: NodeJS.Timer;
        let buffer = "";

        return await new Promise(resolve => {
            const stdOutHandler = (data: string): void => {
                buffer += data;
                console.log(data);
                if (buffer.includes("__ok__linux_dev__\n")) {
                    clearInterval(intHandle);
                    this._crashPs.stdout?.removeListener(
                        "data", stdOutHandler
                    );
                    // Wait a bit to ensure all echo output is consumed
                    setTimeout(() => resolve(true), 100);
                } else if (attempts > STDOUT_OK_MAX_ATTEMPTS) {
                    clearInterval(intHandle);
                    this._crashPs.stdout?.removeListener(
                        "data", stdOutHandler
                    );
                    resolve(false);
                } else {
                    attempts++;
                }
            }
            this._crashPs.stdout?.addListener("data", stdOutHandler);

            intHandle = setInterval(() => {
                // roger?
                this._crashPs.stdin?.write("echo __ok__linux_dev__\n");
            }, 5000);
        });
    }

    public async getCrashStackTrace (): Promise<StackTraceItem[]> {
        const ret = await this._stdinOk();
        console.log("stdin ok? ", ret);

        if (ret) {
            return await new Promise(resolve => {
                const items = new Array<StackTraceItem>();
                let fullOutput = "";
                let isCollecting = false;

                const stdOutHandler = (data: string): void => {
                    console.log(data);

                    // Start collecting after we see the bt command echo or first frame
                    if (!isCollecting && (data.includes("bt -l") || data.includes(" #0 "))) {
                        isCollecting = true;
                    }

                    if (!isCollecting) {
                        return; // Skip any leftover data from previous commands
                    }

                    fullOutput += data;

                    // Check if we have a complete backtrace (ends with crash> prompt or similar)
                    if (fullOutput.includes("crash>") || data.includes("\ncrash>")) {
                        this._crashPs.stdout?.removeListener("data", stdOutHandler);

                        // Parse the complete output
                        const lines = fullOutput.split("\n");
                        let numbered = false;

                        for (const line of lines) {
                            console.log(line);
                            // stack number?
                            if (line.startsWith(" #")) {
                                numbered = true;
                                const splits = line.trim().split(" ");
                                const item: StackTraceItem = {
                                    Position: Number.parseInt(
                                        splits[0].replace("#", "")
                                    ),
                                    Address: splits[1],
                                    Symbol: splits[2],
                                    AtAddr: splits[4].replace("[", "")
                                        .replace("]", ""),
                                    AtFile: "",
                                    AtLine: 0
                                }
                                items.push(item);
                            // we previously get a stack number?
                            } else if (numbered) {
                                numbered = false;
                                // get the file and line
                                const splits = line.trim().split(" ");
                                const item = items[items.length - 1];
                                item.AtFile = splits[0].replace(":", "");
                                item.AtLine = Number.parseInt(splits[1]);
                            } else {
                                numbered = false;
                            }
                        }

                        // here we have now the structured stack trace from crash
                        resolve(items);
                    }
                }

                this._crashPs.stdout?.addListener("data", stdOutHandler);
                // send the command to get the backtrace
                setTimeout(() => {
                    this._crashPs.stdin?.write("bt -l\n");
                }, 1000);
            });
        }

        return [];
    }
}
