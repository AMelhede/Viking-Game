export type ROI = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export type Frame = {
    data: Uint8ClampedArray | number[];
    width: number;
    height: number;
    roi?: ROI;
    rois?: ROI[];
    timestampMs?: number;
};
export interface FrameSource {
    onFrame: ((frame: Frame) => void) | null;
    start(): Promise<void>;
    stop(): Promise<void>;
}
export type FrameSourceErrorCode = "capture_failed" | "face_mesh_failed";
export type FrameSourceError = {
    code: FrameSourceErrorCode;
    stage: "capture" | "face_mesh";
    message: string;
    timestampMs: number;
    cause?: unknown;
};
export interface FrameSourceWithErrors extends FrameSource {
    onError: ((error: FrameSourceError) => void) | null;
    getLastError(): FrameSourceError | null;
}
export declare function averageGreenInROI(frame: Frame, x: number, y: number, w: number, h: number): number;
export declare function averageRgbInROI(frame: Frame, x: number, y: number, w: number, h: number): {
    r: number;
    g: number;
    b: number;
};
export declare function averageGreenInROIWithSkinMask(frame: Frame, x: number, y: number, w: number, h: number): number;
export declare function averageGreenInROIWithSkinMaskStats(frame: Frame, x: number, y: number, w: number, h: number): {
    intensity: number;
    skinRatio: number;
};
export declare function averageRgbInROIWithSkinMaskStats(frame: Frame, x: number, y: number, w: number, h: number): {
    r: number;
    g: number;
    b: number;
    skinRatio: number;
    clipRatio: number;
};
//# sourceMappingURL=frameSource.d.ts.map