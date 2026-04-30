import * as wasm from "../wasm/eeg_wasm.js";
import type { InitInput, InitOutput, SyncInitInput } from "../wasm/eeg_wasm.js";
type EegWasmInitOptions = {
    module_or_path: InitInput | Promise<InitInput>;
};
type EegWasmSyncInitOptions = {
    module: SyncInitInput;
};
export declare function initEegWasm(moduleOrPath?: EegWasmInitOptions | InitInput | Promise<InitInput>): Promise<InitOutput>;
export declare function initEegWasmSync(module: EegWasmSyncInitOptions | SyncInitInput): InitOutput;
export type EegWebRppgPipeline = {
    push_sample(timestampMs: bigint | number, intensity: number): void;
    get_metrics(): string;
    free(): void;
};
export declare function createRppgPipeline(sampleRate: number, windowSec: number): EegWebRppgPipeline;
export type { InitInput, InitOutput };
export * from "./headband.js";
export * from "./errors.js";
export * from "../wasm/eeg_wasm.js";
export { wasm };
//# sourceMappingURL=index.d.ts.map