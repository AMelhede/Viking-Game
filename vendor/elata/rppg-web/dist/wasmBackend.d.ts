export type WasmModule = {
    RppgPipeline?: any;
    WasmRppgPipeline?: any;
    default?: any;
};
export type Backend = {
    newPipeline: (sampleRate: number, windowSec: number) => any;
};
export type WasmImporter = (url: string) => Promise<WasmModule>;
export type LoadWasmBackendOptions = {
    strict?: boolean;
    jsUrl?: string;
    binaryUrl?: string;
    candidateUrls?: string[];
};
export declare class RppgWasmLoadError extends Error {
    readonly code = "RPPG_WASM_LOAD_FAILED";
    readonly attemptedUrls: string[];
    readonly lastError?: unknown;
    constructor(attemptedUrls: string[], lastError?: unknown);
}
export declare function loadWasmBackend(importer?: WasmImporter, options?: LoadWasmBackendOptions): Promise<Backend | null>;
export declare function createUnavailableBackend(): Backend;
//# sourceMappingURL=wasmBackend.d.ts.map