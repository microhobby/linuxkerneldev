import { Subject } from 'await-notify';
import {
    InitializedEvent,
    LoggingDebugSession,
    logger, Logger, StoppedEvent, StackFrame, Source, Thread
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { CrashRuntime } from './CrashRuntime';
// import { CrashRuntime } from './CrashRuntime';

/**
 * This interface describes the mock-debug specific launch attributes
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    crash: string;
    vmlinux: string;
    vmcore: string;
}

export class CrashDebugSession extends LoggingDebugSession {
    private static readonly threadID = 1;
    // TODO
    private readonly _runtime: CrashRuntime;
    // TODO
    // private _variableHandles =
    //    new Handles<'locals' | 'globals' | RuntimeVariable>();
    private readonly _configurationDone = new Subject();
    // private _reportProgress = false;

    // private readonly _valuesInHex = false;
    // private _useInvalidatedEvent = false;

    public constructor () {
        super("crash-debug.txt");

        // this debugger uses zero-based lines and columns
        this.setDebuggerColumnsStartAt1(false);
        this.setDebuggerLinesStartAt1(false);

        // initialize runtime
        this._runtime = new CrashRuntime();

        // TODO: add more features?
        // events
        this._runtime.on('stopOnEntry', () => {
            this.sendEvent(
                new StoppedEvent('entry', CrashDebugSession.threadID)
            );
        });
        // initialize runtime
    }

    protected initializeRequest (
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments
    ): void {
        // TODO: I have no idea for what these are
        // if (args.supportsProgressReporting !== undefined) {
        //     this._reportProgress = true;
        // }

        // if (args.supportsInvalidatedEvent !== undefined) {
        //     this._useInvalidatedEvent = true;
        // }

        // build and return the capabilities of this debug adapter
        if (response.body == null) {
            response.body = {};
        }

        // the adapter implements the configurationDone request.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;

        // make VS Code show a 'step back' button
        response.body.supportsStepBack = false;

        // make VS Code support data breakpoints
        response.body.supportsDataBreakpoints = false;

        // make VS Code support completion in REPL
        response.body.supportsCompletionsRequest = false;
        response.body.completionTriggerCharacters = [".", "["];

        // make VS Code send cancel request
        response.body.supportsCancelRequest = true;

        // make VS Code send the breakpointLocations request
        response.body.supportsBreakpointLocationsRequest = false;

        // make VS Code provide "Step in Target" functionality
        response.body.supportsStepInTargetsRequest = false;

        // the adapter defines exceptions filters
        response.body.supportsExceptionFilterOptions = false;

        // TODO: maybe we can use this for show the fisrt line of the panic
        // make VS Code send exceptionInfo request
        response.body.supportsExceptionInfoRequest = false;

        // make VS Code send setVariable request
        response.body.supportsSetVariable = true;

        // make VS Code send setExpression request
        response.body.supportsSetExpression = true;

        // make VS Code send disassemble request
        response.body.supportsDisassembleRequest = false;
        response.body.supportsSteppingGranularity = false;
        response.body.supportsInstructionBreakpoints = false;

        // make VS Code able to read and write variable memory
        response.body.supportsReadMemoryRequest = true;
        response.body.supportsWriteMemoryRequest = false;

        response.body.supportSuspendDebuggee = true;
        response.body.supportTerminateDebuggee = true;
        response.body.supportsFunctionBreakpoints = false;
        response.body.supportsDelayedStackTraceLoading = true;

        this.sendResponse(response);

        // wait for the configurationDone
        this.sendEvent(new InitializedEvent());
    }

    // called at the end of the configuration sequence
    // the Debug Adapter can now launch
    protected configurationDoneRequest (
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments,
        request?: DebugProtocol.Request | undefined
    ): void {
        this._configurationDone.notify();
    }

    protected disconnectRequest (
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments,
        request?: DebugProtocol.Request | undefined
    ): void {
        console.log(
            // eslint-disable-next-line max-len
            `disconnectRequest suspend: ${args.suspendDebuggee as unknown as string}, terminate: ${args.terminateDebuggee as unknown as string}`
        );
        this._runtime.stop();
    }

    protected async launchRequest (
        response: DebugProtocol.LaunchResponse,
        args: ILaunchRequestArguments,
        request?: DebugProtocol.Request | undefined
    ): Promise<void> {
        // TODO: add some type of trace?
        // make sure to 'Stop' the buffered logging if 'trace' is not set
        logger.setup(
            Logger.LogLevel.Verbose,
            false
        );

        // wait 1 second until configuration has finished
        await this._configurationDone.wait(5000);

        // start the program in the runtime
        await this._runtime.start(args.crash, args.vmlinux, args.vmcore);
    }

    protected setFunctionBreakPointsRequest (
        response: DebugProtocol.SetFunctionBreakpointsResponse,
        args: DebugProtocol.SetFunctionBreakpointsArguments,
        request?: DebugProtocol.Request
    ): void {
        this.sendResponse(response);
    }

    protected async setBreakPointsRequest (
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        this.sendResponse(response);
    }

    protected breakpointLocationsRequest (
        response: DebugProtocol.BreakpointLocationsResponse,
        args: DebugProtocol.BreakpointLocationsArguments,
        request?: DebugProtocol.Request
    ): void {
        this.sendResponse(response);
    }

    protected async setExceptionBreakPointsRequest (
        response: DebugProtocol.SetExceptionBreakpointsResponse,
        args: DebugProtocol.SetExceptionBreakpointsArguments
    ): Promise<void> {
        this.sendResponse(response);
    }

    protected exceptionInfoRequest (
        response: DebugProtocol.ExceptionInfoResponse,
        args: DebugProtocol.ExceptionInfoArguments
    ): void {
        this.sendResponse(response);
    }

    protected threadsRequest (response: DebugProtocol.ThreadsResponse): void {
        // runtime supports no threads so just return a default thread.
        response.body = {
            threads: [
                new Thread(CrashDebugSession.threadID, "panic")
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest (
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments,
        request?: DebugProtocol.Request | undefined
    ): void {
        if (args.levels === 1) {
            const stack: StackFrame[] = [];

            for (const bt of this._runtime.BreakPoints) {
                stack.push({
                    column: 0,
                    id: 0,
                    line: bt.line,
                    endLine: bt.line,
                    source: new Source(bt.file, bt.file),
                    name: bt.symbol
                });
            }

            response.body = {
                stackFrames: stack,
                totalFrames: stack.length
            };

            this.sendResponse(response);
        }
    }
}
