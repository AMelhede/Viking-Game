import type { FrameSource } from "./frameSource.js";
import { type FaceMeshLike } from "./mediaPipeFaceFrameSource.js";
import { RppgProcessor, type Metrics, type RppgDebugIssueCode, type RppgDebugSnapshot, type RppgProcessorBackendFailure, type RppgTraceSnapshot } from "./rppgProcessor.js";
import { type WasmImporter } from "./wasmBackend.js";
import { DemoRunner, type DemoRunnerDiagnostics, type DemoRunnerOptions } from "./demoRunner.js";
export type RppgSessionBackendPreference = "auto" | "wasm";
export type RppgSessionBackendMode = "wasm" | "unavailable";
export type RppgSessionFaceTrackingMode = "face_mesh" | "video_frame";
export type RppgSessionIssueCode = RppgDebugIssueCode | "backend_unavailable" | "face_mesh_unavailable" | "processor_failed";
export type RppgSessionErrorCode = "backend_init_failed" | "face_mesh_init_failed" | "capture_error" | "processor_error";
export type RppgSessionStateStatus = "running" | "degraded" | "failed";
export type RppgSessionStatePhase = "none" | "startup" | "runtime";
export type RppgSessionStateReason = RppgSessionIssueCode | RppgSessionErrorCode | null;
export type RppgSessionError = {
    code: RppgSessionErrorCode;
    stage: "backend" | "face_mesh" | "capture" | "processor";
    message: string;
    timestampMs: number;
    cause?: unknown;
};
export type RppgSessionState = {
    status: RppgSessionStateStatus;
    phase: RppgSessionStatePhase;
    terminal: boolean;
    reason: RppgSessionStateReason;
    errorCode: RppgSessionErrorCode | null;
    errorStage: RppgSessionError["stage"] | null;
};
export type RppgSessionDiagnostics = DemoRunnerDiagnostics & {
    backendMode: RppgSessionBackendMode;
    estimationAvailable: boolean;
    faceTrackingMode: RppgSessionFaceTrackingMode;
    roiSource: DemoRunnerDiagnostics["lastRoiSource"];
    processorMethod: DemoRunnerDiagnostics["lastProcessorMethod"];
    totalSamplesReceived: number;
    windowSampleCount: number;
    windowDurationMs: number;
    lastSampleTimestampMs: number | null;
    lastSampleAgeMs: number | null;
    lastSample: RppgDebugSnapshot["lastSample"];
    processorIssues: RppgDebugIssueCode[];
    issues: RppgSessionIssueCode[];
    processorFailure: RppgProcessorBackendFailure | null;
    state: RppgSessionState;
    lastError: RppgSessionError | null;
};
export type CreateRppgSessionOptions = Omit<DemoRunnerOptions, "onDiagnostics" | "onError"> & {
    video: HTMLVideoElement;
    sampleRate?: number;
    windowSec?: number;
    backend?: RppgSessionBackendPreference;
    /**
     * Face ROI mode.
     * - `"off"` — uses the full video frame as the ROI. No MediaPipe dependency,
     *   no extra download. Good enough when the face fills most of the frame.
     *   Best choice for quick integration or when minimizing bundle size.
     * - `"auto"` — loads MediaPipe FaceMesh (~3 MB) for a tighter face-crop ROI,
     *   which improves signal quality when the user moves or is smaller in frame.
     *   Falls back to `"off"` (video_frame mode) silently if MediaPipe fails to
     *   load. Check `diagnostics.faceTrackingMode` to confirm which mode is
     *   active: `"face_mesh"` means MediaPipe loaded; `"video_frame"` means it
     *   fell back.
     * - A `FaceMeshLike` instance — bring your own pre-loaded FaceMesh object.
     */
    faceMesh?: FaceMeshLike | "auto" | "off";
    ensureVideoPlayback?: boolean;
    videoPlaybackTimeoutMs?: number;
    enableTracker?: boolean | {
        minBpm?: number;
        maxBpm?: number;
        numParticles?: number;
    };
    /**
     * Whether to start the session immediately after creation. Defaults to `true`.
     * Pass `false` to defer capture until you call `session.start()` manually —
     * useful when you want to show UI or request permissions before capture begins.
     */
    autoStart?: boolean;
    /**
     * URL of the wasm-bindgen JS glue file to load.
     * Defaults to `/pkg/rppg_wasm.js`, then falls back to `/pkg/eeg_wasm.js`
     * and root-path variants. This means **if you have `@elata-biosciences/eeg-web`
     * installed, you do not need to build rppg-web's WASM separately** — copy or
     * symlink `node_modules/@elata-biosciences/eeg-web/wasm/` to `public/pkg/` and
     * the eeg WASM will be found automatically (it exports `RppgPipeline`).
     * In a Vite app, use a `?url` import to avoid public-directory restrictions:
     * `import url from "@elata-biosciences/eeg-web/wasm/eeg_wasm.js?url"`
     */
    wasmJsUrl?: string;
    /**
     * URL of the `.wasm` binary file.
     * Only needed when the wasm-bindgen JS glue cannot infer the binary path
     * automatically (e.g. when using a `?url` import in Vite).
     * `import url from "@elata-biosciences/rppg-web/pkg/rppg_wasm_bg.wasm?url"`
     */
    wasmBinaryUrl?: string;
    /**
     * Custom WASM module importer. Replaces the default `import(url)` call.
     * Use this in Vite (which blocks dynamic imports from `/public`) by
     * statically importing the WASM JS bundle and returning it here:
     * ```ts
     * import * as rppgWasm from "@elata-biosciences/rppg-web/pkg/rppg_wasm.js";
     * wasmImporter: () => Promise.resolve(rppgWasm)
     * ```
     */
    wasmImporter?: WasmImporter;
    onDiagnostics?: (diagnostics: RppgSessionDiagnostics) => void;
    onError?: (error: RppgSessionError) => void;
};
type SessionInternals = {
    onDiagnostics?: (diagnostics: RppgSessionDiagnostics) => void;
    onError?: (error: RppgSessionError) => void;
    backendDegraded?: boolean;
    faceTrackingDegraded?: boolean;
    beforeStart?: () => Promise<void>;
};
export declare class RppgSession {
    readonly source: FrameSource;
    readonly processor: RppgProcessor;
    readonly runner: DemoRunner;
    readonly backendMode: RppgSessionBackendMode;
    readonly faceTrackingMode: RppgSessionFaceTrackingMode;
    private readonly internals;
    private lastErrorValue;
    constructor(source: FrameSource, processor: RppgProcessor, runner: DemoRunner, backendMode: RppgSessionBackendMode, faceTrackingMode: RppgSessionFaceTrackingMode, internals?: SessionInternals);
    get lastError(): RppgSessionError | null;
    get state(): RppgSessionState;
    getMetrics(): Metrics;
    getDebugSnapshot(nowMs?: number): RppgDebugSnapshot;
    getTraceSnapshot(maxPoints?: number): RppgTraceSnapshot;
    getState(): RppgSessionState;
    getDiagnostics(nowMs?: number): RppgSessionDiagnostics;
    start(): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void>;
    recordError(error: RppgSessionError): void;
    emitDiagnostics(): void;
}
export declare function createRppgSession(options: CreateRppgSessionOptions): Promise<RppgSession>;
export {};
//# sourceMappingURL=rppgSession.d.ts.map