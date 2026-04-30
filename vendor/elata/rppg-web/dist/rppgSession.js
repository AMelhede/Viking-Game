import { MediaPipeFaceFrameSource, } from "./mediaPipeFaceFrameSource.js";
import { MediaPipeFrameSource } from "./mediaPipeFrameSource.js";
import { loadFaceMesh } from "./mediapipeLoader.js";
import { ensureVideoPlaying } from "./videoPlayback.js";
import { RppgProcessor, } from "./rppgProcessor.js";
import { loadWasmBackend, createUnavailableBackend, } from "./wasmBackend.js";
import { DemoRunner, } from "./demoRunner.js";
export class RppgSession {
    constructor(source, processor, runner, backendMode, faceTrackingMode, internals = {}) {
        this.source = source;
        this.processor = processor;
        this.runner = runner;
        this.backendMode = backendMode;
        this.faceTrackingMode = faceTrackingMode;
        this.internals = internals;
        this.lastErrorValue = null;
    }
    get lastError() {
        return this.lastErrorValue;
    }
    get state() {
        return this.getState();
    }
    getMetrics() {
        return this.processor.getMetrics();
    }
    getDebugSnapshot(nowMs = Date.now()) {
        return this.processor.getDebugSnapshot(nowMs);
    }
    getTraceSnapshot(maxPoints = 300) {
        return this.processor.getTraceSnapshot(maxPoints);
    }
    getState() {
        const processorFailure = this.processor.getBackendFailure();
        const lastError = this.lastErrorValue;
        const terminal = processorFailure != null || lastError?.code === "processor_error";
        if (terminal) {
            return {
                status: "failed",
                phase: "runtime",
                terminal: true,
                reason: lastError?.code ?? "processor_failed",
                errorCode: lastError?.code ?? "processor_error",
                errorStage: lastError?.stage ?? "processor",
            };
        }
        if (lastError) {
            const startupFailure = lastError.code === "backend_init_failed" ||
                lastError.code === "face_mesh_init_failed";
            return {
                status: "degraded",
                phase: startupFailure ? "startup" : "runtime",
                terminal: false,
                reason: lastError.code,
                errorCode: lastError.code,
                errorStage: lastError.stage,
            };
        }
        if (this.internals.backendDegraded) {
            return {
                status: "degraded",
                phase: "startup",
                terminal: false,
                reason: "backend_unavailable",
                errorCode: null,
                errorStage: null,
            };
        }
        if (this.internals.faceTrackingDegraded) {
            return {
                status: "degraded",
                phase: "startup",
                terminal: false,
                reason: "face_mesh_unavailable",
                errorCode: null,
                errorStage: null,
            };
        }
        return {
            status: "running",
            phase: "none",
            terminal: false,
            reason: null,
            errorCode: null,
            errorStage: null,
        };
    }
    getDiagnostics(nowMs = Date.now()) {
        const runnerDiagnostics = this.runner.getDiagnostics();
        const debugSnapshot = this.processor.getDebugSnapshot(nowMs);
        const processorFailure = this.processor.getBackendFailure();
        const state = this.getState();
        const issues = new Set(debugSnapshot.issues);
        if (this.internals.backendDegraded)
            issues.add("backend_unavailable");
        if (this.internals.faceTrackingDegraded)
            issues.add("face_mesh_unavailable");
        if (state.status === "failed")
            issues.add("processor_failed");
        return {
            ...runnerDiagnostics,
            backendMode: this.backendMode,
            estimationAvailable: this.backendMode === "wasm" && processorFailure == null,
            faceTrackingMode: this.faceTrackingMode,
            roiSource: runnerDiagnostics.lastRoiSource,
            processorMethod: runnerDiagnostics.lastProcessorMethod,
            totalSamplesReceived: debugSnapshot.totalSamplesReceived,
            windowSampleCount: debugSnapshot.windowSampleCount,
            windowDurationMs: debugSnapshot.windowDurationMs,
            lastSampleTimestampMs: debugSnapshot.lastSampleTimestampMs,
            lastSampleAgeMs: debugSnapshot.lastSampleAgeMs,
            lastSample: debugSnapshot.lastSample,
            processorIssues: debugSnapshot.issues,
            issues: Array.from(issues),
            processorFailure,
            state,
            lastError: this.lastErrorValue,
        };
    }
    async start() {
        await this.internals.beforeStart?.();
        await this.runner.start();
        this.emitDiagnostics();
    }
    async stop() {
        await this.runner.stop();
        this.emitDiagnostics();
    }
    async dispose() {
        await this.stop();
        this.processor.dispose();
    }
    recordError(error) {
        if (this.lastErrorValue?.code === "processor_error") {
            return;
        }
        this.lastErrorValue = error;
        this.internals.onError?.(error);
        this.emitDiagnostics();
    }
    emitDiagnostics() {
        this.internals.onDiagnostics?.(this.getDiagnostics());
    }
}
export async function createRppgSession(options) {
    const sampleRate = options.sampleRate ?? 30;
    const windowSec = options.windowSec ?? 10;
    const backendPreference = options.backend ?? "auto";
    const enableTracker = options.enableTracker ?? true;
    const pendingErrors = [];
    const faceMeshResult = await resolveFaceMesh(options.faceMesh);
    if (faceMeshResult.error)
        pendingErrors.push(faceMeshResult.error);
    const faceTrackingMode = faceMeshResult.faceMesh
        ? "face_mesh"
        : "video_frame";
    const source = faceMeshResult.faceMesh
        ? new MediaPipeFaceFrameSource(options.video, faceMeshResult.faceMesh, sampleRate)
        : new MediaPipeFrameSource(options.video, { fps: sampleRate });
    const backendResult = await resolveBackend(backendPreference, {
        wasmJsUrl: options.wasmJsUrl,
        wasmBinaryUrl: options.wasmBinaryUrl,
        wasmImporter: options.wasmImporter,
    });
    const processor = new RppgProcessor(backendResult.backend, sampleRate, windowSec);
    applyTrackerConfiguration(processor, enableTracker);
    let session = null;
    const runner = new DemoRunner(source, processor, {
        roi: options.roi,
        roiSmoothingAlpha: options.roiSmoothingAlpha ?? 0.25,
        useSkinMask: options.useSkinMask ?? true,
        onStats: options.onStats,
        skinRatioSmoothingAlpha: options.skinRatioSmoothingAlpha,
        onDiagnostics: () => {
            session?.emitDiagnostics();
        },
        onError: (error) => {
            session?.recordError({
                code: "processor_error",
                stage: "processor",
                message: error.message,
                timestampMs: error.timestampMs,
                cause: error.cause,
            });
        },
    });
    session = new RppgSession(source, processor, runner, backendResult.mode, faceTrackingMode, {
        onDiagnostics: options.onDiagnostics,
        onError: options.onError,
        backendDegraded: backendResult.mode !== "wasm",
        faceTrackingDegraded: faceMeshResult.error != null,
        beforeStart: options.ensureVideoPlayback === false
            ? undefined
            : () => ensureVideoPlaying(options.video, {
                timeoutMs: options.videoPlaybackTimeoutMs,
            }),
    });
    attachSourceErrorForwarder(source, session);
    for (const error of pendingErrors) {
        session.recordError(error);
    }
    if (options.autoStart !== false) {
        await session.start();
    }
    return session;
}
async function resolveFaceMesh(faceMeshOption) {
    if (faceMeshOption && faceMeshOption !== "auto" && faceMeshOption !== "off") {
        return { faceMesh: faceMeshOption, error: null };
    }
    if (faceMeshOption === "off") {
        return { faceMesh: null, error: null };
    }
    try {
        const faceMesh = await loadFaceMesh();
        return { faceMesh, error: null };
    }
    catch (cause) {
        return {
            faceMesh: null,
            error: {
                code: "face_mesh_init_failed",
                stage: "face_mesh",
                message: cause instanceof Error
                    ? cause.message
                    : "FaceMesh failed to initialize.",
                timestampMs: Date.now(),
                cause,
            },
        };
    }
}
async function resolveBackend(backendPreference, options) {
    const backend = await loadWasmBackend(options.wasmImporter, {
        strict: backendPreference === "wasm",
        jsUrl: options.wasmJsUrl,
        binaryUrl: options.wasmBinaryUrl,
    });
    if (backend) {
        return { backend, mode: "wasm" };
    }
    return { backend: createUnavailableBackend(), mode: "unavailable" };
}
function applyTrackerConfiguration(processor, enableTracker) {
    if (!enableTracker)
        return;
    if (enableTracker === true) {
        processor.enableTracker(55, 150, 200);
        return;
    }
    processor.enableTracker(enableTracker.minBpm ?? 55, enableTracker.maxBpm ?? 150, enableTracker.numParticles ?? 200);
}
function attachSourceErrorForwarder(source, session) {
    const errorSource = source;
    if (typeof errorSource.getLastError !== "function")
        return;
    errorSource.onError = (error) => {
        session.recordError({
            code: error.stage === "face_mesh" ? "face_mesh_init_failed" : "capture_error",
            stage: error.stage,
            message: error.message,
            timestampMs: error.timestampMs,
            cause: error.cause,
        });
    };
}
