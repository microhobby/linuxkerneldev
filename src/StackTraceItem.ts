
export interface StackTraceItem {
    Position: number;
    Address: string;
    Symbol: string;
    AtAddr: string;
    AtFile: string;
    AtLine: number;

    // TODO: add the frame registers
}
