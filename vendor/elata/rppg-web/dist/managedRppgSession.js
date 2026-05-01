import { createRppgSession, } from "./rppgSession.js";
const DEFAULT_RETRY_DELAY_MS = 1500;
const DEFAULT_MAX_RETRIES = 3;
function safeMetrics() {
    return {
        bpm: null,
        confidence: 0,
        signal_quality: 0,
    };
}
function emptyTraceSnapshot() {
    return {
        sampleRate: 0,
        windowSec: 0,
        totalSamplesReceived: 0,
        windowSampleCount: 0,
        windowDurationMs: 0,
        durationSec: 0,
        points: [],
        lastSample: null,
        backendFailure: null,
    };
}
export class ManagedRppgSession {
    constructor(options, internals = {}) {
        this.options = options;
        this.internals = internals;
        this.activeSession = null;
        this.retryTimer = null;
        this.generation = 0;
        this.startPromise = null;
        this.stopped = false;
        this.lastDiagnosticsValue = null;
        this.stateValue = {
            status: "idle",
            retryCount: 0,
            maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
            retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
            restartOnProcessorFailure: options.restartOnProcessorFailure !== false,
            lastError: null,
            nextRetryAtMs: null,
        };
    }
    get session() {
        return this.activeSession;
    }
    get state() {
        return { ...this.stateValue };
    }
    get lastError() {
        return this.stateValue.lastError;
    }
    getDiagnostics() {
        return this.lastDiagnosticsValue;
    }
    getMetrics() {
        return this.activeSession?.getMetrics() ?? safeMetrics();
    }
    getTraceSnapshot(maxPoints = 300) {
        return this.activeSession?.getTraceSnapshot(maxPoints) ?? emptyTraceSnapshot();
    }
    async start() {
        this.stopped = false;
        if (this.startPromise)
            return this.startPromise;
        if (this.retryTimer) {
            this.clearRetryTimer();
        }
        this.startPromise = this.startInternal();
        try {
            await this.startPromise;
        }
        finally {
            this.startPromise = null;
        }
    }
    async restart() {
        this.stateValue.retryCount = 0;
        await this.stop();
        await this.start();
    }
    async stop() {
        this.stopped = true;
        this.clearRetryTimer();
        this.generation += 1;
        const session = this.activeSession;
        this.activeSession = null;
        if (session) {
            await session.dispose();
        }
        this.updateState({
            status: "stopped",
            nextRetryAtMs: null,
        });
    }
    async dispose() {
        await this.stop();
    }
    async startInternal() {
        const generation = ++this.generation;
        const retryCount = this.stateValue.retryCount;
        this.updateState({
            status: "starting",
            lastError: null,
            nextRetryAtMs: null,
        });
        const sessionOptions = this.buildSessionOptions(generation);
        const sessionFactory = this.internals.sessionFactory ?? createRppgSession;
        try {
            const session = await sessionFactory(sessionOptions);
            if (this.stopped || generation !== this.generation) {
                await session.dispose();
                return;
            }
            this.activeSession = session;
            this.lastDiagnosticsValue = session.getDiagnostics();
            this.updateState({
                status: "running",
                retryCount,
                lastError: null,
                nextRetryAtMs: null,
            });
        }
        catch (error) {
            const sessionError = normalizeSessionError(error);
            this.updateState({
                status: "failed",
                lastError: sessionError,
                nextRetryAtMs: null,
            });
            throw error;
        }
    }
    buildSessionOptions(generation) {
        const { maxRetries: _maxRetries, retryDelayMs: _retryDelayMs, restartOnProcessorFailure: _restartOnProcessorFailure, onStateChange: _onStateChange, onDiagnostics, onError, ...sessionOptions } = this.options;
        return {
            ...sessionOptions,
            autoStart: true,
            onDiagnostics: (diagnostics) => {
                if (generation !== this.generation || this.stopped)
                    return;
                this.lastDiagnosticsValue = diagnostics;
                onDiagnostics?.(diagnostics);
            },
            onError: (error) => {
                if (generation !== this.generation || this.stopped)
                    return;
                this.updateState({
                    lastError: error,
                });
                onError?.(error);
                void this.handleSessionError(error, generation);
            },
        };
    }
    async handleSessionError(error, generation) {
        if (error.code !== "processor_error" ||
            !this.stateValue.restartOnProcessorFailure ||
            this.stopped ||
            generation !== this.generation) {
            await this.disposeActiveSession();
            this.updateState({
                status: "failed",
                lastError: error,
                nextRetryAtMs: null,
            });
            return;
        }
        if (this.stateValue.retryCount >= this.stateValue.maxRetries) {
            await this.disposeActiveSession();
            this.updateState({
                status: "failed",
                lastError: error,
                nextRetryAtMs: null,
            });
            return;
        }
        await this.disposeActiveSession();
        const nextRetryAtMs = Date.now() + this.stateValue.retryDelayMs;
        this.updateState({
            status: "retrying",
            lastError: error,
            nextRetryAtMs,
        });
        const setTimeoutFn = this.internals.setTimeoutFn ?? setTimeout;
        this.retryTimer = setTimeoutFn(() => {
            this.retryTimer = null;
            if (this.stopped || generation !== this.generation)
                return;
            this.stateValue.retryCount += 1;
            void this.start();
        }, this.stateValue.retryDelayMs);
    }
    clearRetryTimer() {
        if (!this.retryTimer)
            return;
        const clearTimeoutFn = this.internals.clearTimeoutFn ?? clearTimeout;
        clearTimeoutFn(this.retryTimer);
        this.retryTimer = null;
    }
    async disposeActiveSession() {
        const currentSession = this.activeSession;
        this.activeSession = null;
        if (currentSession) {
            await currentSession.dispose();
        }
    }
    updateState(patch) {
        this.stateValue = {
            ...this.stateValue,
            ...patch,
        };
        this.options.onStateChange?.(this.state);
    }
}
export async function createManagedRppgSession(options) {
    const managed = new ManagedRppgSession(options);
    if (options.autoStart !== false) {
        await managed.start();
    }
    return managed;
}
function normalizeSessionError(error) {
    if (error &&
        typeof error === "object" &&
        "code" in error &&
        "stage" in error &&
        "message" in error) {
        return error;
    }
    return {
        code: "backend_init_failed",
        stage: "backend",
        message: error instanceof Error ? error.message : "Failed to start managed rPPG session.",
        timestampMs: Date.now(),
        cause: error,
    };
}
