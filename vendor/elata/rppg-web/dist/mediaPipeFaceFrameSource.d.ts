import { FrameSource, Frame, type FrameSourceError } from "./frameSource.js";
export type FaceMeshLike = {
    onResults?: (results: any) => void;
    send: (opts: {
        image: HTMLVideoElement;
    }) => void;
};
export declare class MediaPipeFaceFrameSource implements FrameSource {
    private video;
    private faceMesh;
    private fps;
    onFrame: ((frame: Frame) => void) | null;
    onError: ((error: FrameSourceError) => void) | null;
    private running;
    private canvas;
    private ctx;
    private lastResults;
    private latestLandmarks;
    private vfcHandle;
    private callback;
    private smoothedFaceRoi;
    private lastError;
    constructor(video: HTMLVideoElement, faceMesh: FaceMeshLike, fps?: number);
    start(): Promise<void>;
    stop(): Promise<void>;
    getLastError(): FrameSourceError | null;
    private captureAndEmitFrame;
    private landmarksToROI;
    private smoothRoi;
    private subRoisFromFace;
    private reportError;
}
//# sourceMappingURL=mediaPipeFaceFrameSource.d.ts.map