import * as fs from 'fs';
import { PathLike } from 'fs';
import * as path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as os from 'os';

/**
 * Try to not use VSCode dependencies
 */

export class CrossSpawn {
    public static spawn (
        cmd: string,
        args?: string[],
        useDocker?: boolean,
        bindmount?: PathLike
    ): ChildProcessWithoutNullStreams {
        if (os.platform() === "win32" || useDocker) {
            // use docker
            let dockerArgs = [
                "run",
                "--rm",
                "-t",
                "-v",
                `${bindmount}:/bindmount`,
                "seadoglinux/utils",
                cmd
            ];

            if (args)
                dockerArgs = dockerArgs.concat(args);
            
            return spawn(
                "docker",
                dockerArgs,
                {
				    shell: true,
				    windowsHide: true,
				    detached: true
			    }
            );
        } else {
            return spawn(
                cmd,
                args,
                {
                    shell: true,
                    windowsHide: true,
                    detached: true
                }
            );
        }
    }
}
