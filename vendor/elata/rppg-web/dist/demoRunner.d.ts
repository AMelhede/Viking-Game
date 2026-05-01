import { FrameSource } from "./frameSource.js";
import { RppgProcessor } from "./rppgProcessor.js";
export type DemoRunnerOptions = {
    roi?: {
        x: number;
        y: number;
        w: number;
        h: number;
    } | null;
    sampleRate?: number;
    roiSmoothingAlpha?: number;
    useSkinMask?: boolean;
    onStats?: (stats: {
        intensity: number;
        skinRatio: number;
        fps: number | null;
        r: number;
        g: number;
        b: number;
        clipRatio: number;
        motion: number;
    }) => void;
    onDiagnostics?: (diagnostics: DemoRunnerDiagnostics) => void;
    onError?: (error: DemoRunnerError) => void;
    skinRatioSmoothingAlpha?: number;
};
export type DemoRunnerDropReason = "frame_invalid" | "roi_missing" | "non_finite_intensity" | "processor_error";
export type DemoRunnerDiagnostics = {
    framesSeen: number;
    framesWithFaceRoi: number;
    framesWithFallbackRoi: number;
    framesWithMultiRoi: number;
    samplesPushed: number;
    droppedFrames: number;
    lastDropReason: DemoRunnerDropReason | null;
    lastTimestampMs: number | null;
    lastIntensity: number | null;
    lastSkinRatio: number | null;
    lastClipRatio: number | null;
    lastMotion: number | null;
    lastProcessorMethod: "rgb_meta" | "rgb" | "intensity" | null;
    lastRoiSource: "multi_roi" | "face_roi" | "fallback_roi" | null;
};
export type DemoRunnerError = {
    code: "processor_error";
    stage: "processor";
    message: string;
    timestampMs: number;
    diagnostics: DemoRunnerDiagnostics;
    cause?: unknown;
};
export declare class DemoRunner {
    private source;
    private processor;
    private opts;
    private running;
    private frameCount;
    private lastSampleTs;
    private smoothedRoi;
    private frameTimes;
    private lastFps;
    private lastCenter;
    private smoothedSkinRatio;
    private diagnostics;
    private lastError;
    constructor(source: FrameSource, processor: RppgProcessor, opts?: DemoRunnerOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    getDiagnostics(): DemoRunnerDiagnostics;
    getLastError(): DemoRunnerError | null;
    private onFrame;
    private recordDrop;
    private recordError;
    private emitDiagnostics;
}
//# sourceMappingURL=demoRunner.d.ts.map