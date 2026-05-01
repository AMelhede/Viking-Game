export declare class ChannelGainController {
    private baseline;
    private initialized;
    private readonly targetLevel;
    reset(): void;
    process(r: number, g: number, b: number): {
        r: number;
        g: number;
        b: number;
    };
}
export declare class ChromPulseModel {
    private readonly windowSize;
    private rQueue;
    private gQueue;
    private bQueue;
    constructor(windowSize?: number);
    reset(): void;
    process(r: number, g: number, b: number): number;
}
export declare function computeSignalSnrDb(values: number[]): number;
//# sourceMappingURL=rppgSignalModel.d.ts.map