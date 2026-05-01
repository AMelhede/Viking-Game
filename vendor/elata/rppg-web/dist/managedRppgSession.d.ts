import { type CreateRppgSessionOptions, type RppgSession, type RppgSessionDiagnostics, type RppgSessionError } from "./rppgSession.js";
import type { Metrics, RppgTraceSnapshot } from "./rppgProcessor.js";
export type ManagedRppgSessionStatus = "idle" | "starting" | "running" | "retrying" | "failed" | "stopped";
export type ManagedRppgSessionState = {
    status: ManagedRppgSessionStatus;
    retryCount: number;
    maxRetries: number;
    retryDelayMs: number;
    restartOnProcessorFailure: boolean;
    lastError: RppgSessionError | null;
    nextRetryAtMs: number | null;
};
export type CreateManagedRppgSessionOptions = CreateRppgSessionOptions & {
    maxRetries?: number;
    retryDelayMs?: number;
    restartOnProcessorFailure?: boolean;
    onStateChange?: (state: ManagedRppgSessionState) => void;
};
type ManagedRppgSessionInternals = {
    sessionFactory?: (options: CreateRppgSessionOptions) => Promise<RppgSession>;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
};
export declare class ManagedRppgSession {
    private readonly options;
    private readonly internals;
    private activeSession;
    private retryTimer;
    private generation;
    private startPromise;
    private stopped;
    private lastDiagnosticsValue;
    private stateValue;
    constructor(options: CreateManagedRppgSessionOptions, internals?: ManagedRppgSessionInternals);
    get session(): RppgSession | null;
    get state(): ManagedRppgSessionState;
    get lastError(): RppgSessionError | null;
    getDiagnostics(): RppgSessionDiagnostics | null;
    getMetrics(): Metrics;
    getTraceSnapshot(maxPoints?: number): RppgTraceSnapshot;
    start(): Promise<void>;
    restart(): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void>;
    private startInternal;
    private buildSessionOptions;
    private handleSessionError;
    private clearRetryTimer;
    private disposeActiveSession;
    private updateState;
}
export declare function createManagedRppgSession(options: CreateManagedRppgSessionOptions): Promise<ManagedRppgSession>;
export {};
//# sourceMappingURL=managedRppgSession.d.ts.map