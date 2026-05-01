import { type RppgGatingOptions, type RppgGatingOutput } from "./rppgGating.js";
import { type RppgNormalizedError, type RppgNormalizedErrorCode } from "./rppgErrors.js";
import type { ManagedRppgSessionState } from "./managedRppgSession.js";
import type { Metrics, RppgProcessorBackendFailure, RppgTraceSnapshot } from "./rppgProcessor.js";
import type { RppgSessionBackendMode, RppgSessionDiagnostics, RppgSessionError, RppgSessionFaceTrackingMode, RppgSessionIssueCode, RppgSessionState } from "./rppgSession.js";
export type RppgAppStatus = "idle" | "starting" | "retrying" | "running" | "ready" | "degraded" | "failed" | "stopped";
export type RppgAppGuidanceCode = RppgNormalizedErrorCode | RppgGatingOutput["guidance"]["code"] | "starting" | "retrying" | "stopped";
export type RppgAppGuidance = {
    code: RppgAppGuidanceCode;
    message: string;
};
export type RppgAppAdapterSource = {
    state: RppgSessionState | ManagedRppgSessionState;
    lastError: RppgSessionError | null;
    getMetrics(): Metrics;
    getDiagnostics(): RppgSessionDiagnostics | null;
    getTraceSnapshot(maxPoints?: number): RppgTraceSnapshot;
};
export type CreateRppgAppAdapterOptions = {
    maxTracePoints?: number;
    gating?: RppgGatingOptions;
    nowMs?: () => number;
};
export type RppgAppSnapshotListener = (snapshot: RppgAppSnapshot) => void;
export type CreateRppgAppMonitorOptions = CreateRppgAppAdapterOptions & {
    intervalMs?: number;
    emitImmediately?: boolean;
};
export type RppgAppSnapshot = {
    status: RppgAppStatus;
    ready: boolean;
    canPublish: boolean;
    publishBpm: number | null;
    message: string;
    guidance: RppgAppGuidance;
    metrics: Metrics;
    diagnostics: RppgSessionDiagnostics | null;
    trace: RppgTraceSnapshot;
    normalizedError: RppgNormalizedError | null;
    sessionState: RppgSessionState | null;
    managedState: ManagedRppgSessionState | null;
    gating: RppgGatingOutput;
    debug: {
        backendMode: RppgSessionBackendMode | null;
        faceTrackingMode: RppgSessionFaceTrackingMode | null;
        issues: RppgSessionIssueCode[];
        processorFailure: RppgProcessorBackendFailure | null;
        retryCount: number;
        nextRetryAtMs: number | null;
        totalSamplesReceived: number;
        windowSampleCount: number;
        estimationAvailable: boolean;
        gatingState: RppgGatingOutput["state"];
        gatingReasons: string[];
    };
};
export declare class RppgAppAdapter {
    private readonly gating;
    private readonly nowMsValue;
    private readonly maxTracePointsValue;
    constructor(options?: CreateRppgAppAdapterOptions);
    reset(): void;
    getSnapshot(source: RppgAppAdapterSource): RppgAppSnapshot;
}
export declare function createRppgAppAdapter(options?: CreateRppgAppAdapterOptions): RppgAppAdapter;
type RppgAppMonitorInternals = {
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
};
export declare class RppgAppMonitor {
    private readonly source;
    private readonly adapter;
    private readonly intervalMs;
    private readonly emitImmediately;
    private readonly setIntervalFn;
    private readonly clearIntervalFn;
    private readonly listeners;
    private timer;
    constructor(source: RppgAppAdapterSource, options?: CreateRppgAppMonitorOptions, internals?: RppgAppMonitorInternals);
    getSnapshot(): RppgAppSnapshot;
    subscribe(listener: RppgAppSnapshotListener): () => void;
    start(): void;
    stop(): void;
    emit(): RppgAppSnapshot;
    dispose(): void;
}
export declare function createRppgAppMonitor(source: RppgAppAdapterSource, options?: CreateRppgAppMonitorOptions): RppgAppMonitor;
export {};
//# sourceMappingURL=rppgAppAdapter.d.ts.map