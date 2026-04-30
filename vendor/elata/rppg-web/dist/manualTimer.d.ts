export declare class ManualPulseTimer {
	private startMs;
	private pausedElapsedMs;
	private count;
	start(): void;
	stop(): void;
	reset(): void;
	tap(): void;
	getCount(): number;
	getElapsedMs(): number;
	getElapsedSeconds(): number;
	getBpm(): number | null;
}
//# sourceMappingURL=manualTimer.d.ts.map
