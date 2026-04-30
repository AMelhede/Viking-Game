import { FrameSource, Frame, type FrameSourceError } from "./frameSource.js";
type Options = {
    fps?: number;
};
export declare class MediaPipeFrameSource implements FrameSource {
    private video;
    private opts;
    onFrame: ((frame: Frame) => void) | null;
    onError: ((error: FrameSourceError) => void) | null;
    private running;
    private timer;
    private vfcHandle;
    private canvas;
    private ctx;
    private lastError;
    constructor(video: HTMLVideoElement, opts?: Options);
    start(): Promise<void>;
    stop(): Promise<void>;
    getLastError(): FrameSourceError | null;
    private captureFrame;
    private reportError;
}
export {};
//# sourceMappingURL=mediaPipeFrameSource.d.ts.map