export class MediaPipeFaceFrameSource {
    constructor(video, faceMesh, fps = 30) {
        this.video = video;
        this.faceMesh = faceMesh;
        this.fps = fps;
        this.onFrame = null;
        this.onError = null;
        this.running = false;
        this.lastResults = null;
        this.latestLandmarks = null;
        this.vfcHandle = null;
        this.callback = null;
        this.smoothedFaceRoi = null;
        this.lastError = null;
        this.canvas = document.createElement("canvas");
        this.canvas.width = video.videoWidth || video.width || 320;
        this.canvas.height = video.videoHeight || video.height || 240;
        const ctx = this.canvas.getContext("2d");
        if (!ctx)
            throw new Error("2D context unavailable");
        this.ctx = ctx;
        // hook faceMesh results
        const handleResults = (res) => {
            this.lastResults = res;
            if (res && res.multiFaceLandmarks && res.multiFaceLandmarks.length > 0) {
                this.latestLandmarks = res.multiFaceLandmarks[0];
            }
            // For environments without requestVideoFrameCallback, emit immediately.
            if (!this.video.requestVideoFrameCallback) {
                this.captureAndEmitFrame(res, Date.now(), null);
            }
        };
        const onResults = this.faceMesh.onResults;
        if (typeof onResults === "function") {
            onResults.call(this.faceMesh, handleResults);
        }
        else {
            this.faceMesh.onResults = handleResults;
        }
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        // continuous send video frames to faceMesh
        const interval = 1000 / this.fps;
        const vfc = this.video.requestVideoFrameCallback;
        if (typeof vfc === "function") {
            const cb = (now, metadata) => {
                if (!this.running)
                    return;
                try {
                    this.faceMesh.send({ image: this.video });
                }
                catch (error) {
                    this.reportError("face_mesh_failed", "face_mesh", error);
                }
                this.captureAndEmitFrame(this.lastResults, now, metadata);
                this.vfcHandle = this.video.requestVideoFrameCallback(cb);
            };
            this.vfcHandle = this.video.requestVideoFrameCallback(cb);
        }
        else {
            const tick = () => {
                if (!this.running)
                    return;
                try {
                    this.faceMesh.send({ image: this.video });
                }
                catch (error) {
                    this.reportError("face_mesh_failed", "face_mesh", error);
                }
                setTimeout(tick, interval);
            };
            tick();
        }
    }
    async stop() {
        this.running = false;
        this.smoothedFaceRoi = null;
        const cancel = this.video.cancelVideoFrameCallback;
        if (this.vfcHandle !== null && typeof cancel === "function") {
            cancel.call(this.video, this.vfcHandle);
            this.vfcHandle = null;
        }
    }
    getLastError() {
        return this.lastError;
    }
    captureAndEmitFrame(results, now, metadata) {
        try {
            this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
            const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            const ts = typeof metadata?.mediaTime === "number"
                ? metadata.mediaTime * 1000
                : (now ?? Date.now());
            const frame = {
                data: img.data,
                width: this.canvas.width,
                height: this.canvas.height,
                timestampMs: ts,
            };
            // compute ROI from results if available
            const landmarks = this.latestLandmarks ?? results?.multiFaceLandmarks?.[0] ?? null;
            if (landmarks) {
                const raw = this.landmarksToROI(landmarks, frame.width, frame.height);
                const roi = this.smoothRoi(raw, frame.width, frame.height);
                frame.roi = roi;
                frame.rois = this.subRoisFromFace(roi);
            }
            if (this.onFrame)
                this.onFrame(frame);
        }
        catch (error) {
            this.reportError("capture_failed", "capture", error);
        }
    }
    landmarksToROI(landmarks, width, height) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of landmarks) {
            const x = (p.x ?? 0) * width;
            const y = (p.y ?? 0) * height;
            if (x < minX)
                minX = x;
            if (y < minY)
                minY = y;
            if (x > maxX)
                maxX = x;
            if (y > maxY)
                maxY = y;
        }
        // add small padding
        const padX = Math.max(4, Math.floor((maxX - minX) * 0.15));
        const padY = Math.max(4, Math.floor((maxY - minY) * 0.15));
        const x = Math.max(0, Math.floor(minX - padX));
        const y = Math.max(0, Math.floor(minY - padY));
        const w = Math.min(width - x, Math.ceil(maxX - minX + 2 * padX));
        const h = Math.min(height - y, Math.ceil(maxY - minY + 2 * padY));
        return { x, y, w, h };
    }
    smoothRoi(next, width, height) {
        const prev = this.smoothedFaceRoi;
        if (!prev) {
            const init = clampRoi(next, { x: 0, y: 0, w: width, h: height });
            this.smoothedFaceRoi = init;
            return init;
        }
        const prevCx = prev.x + prev.w * 0.5;
        const prevCy = prev.y + prev.h * 0.5;
        const nextCx = next.x + next.w * 0.5;
        const nextCy = next.y + next.h * 0.5;
        const dx = nextCx - prevCx;
        const dy = nextCy - prevCy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDim = Math.max(prev.w, prev.h);
        const jump = dist > maxDim * 0.35;
        const alpha = jump ? 0.65 : 0.22;
        const blended = {
            x: prev.x + (next.x - prev.x) * alpha,
            y: prev.y + (next.y - prev.y) * alpha,
            w: prev.w + (next.w - prev.w) * alpha,
            h: prev.h + (next.h - prev.h) * alpha,
        };
        const clamped = clampRoi(blended, { x: 0, y: 0, w: width, h: height });
        this.smoothedFaceRoi = clamped;
        return clamped;
    }
    subRoisFromFace(face) {
        const x = face.x;
        const y = face.y;
        const w = face.w;
        const h = face.h;
        const rois = [];
        // Forehead (top-middle)
        rois.push(clampRoi({
            x: x + w * 0.3,
            y: y + h * 0.05,
            w: w * 0.4,
            h: h * 0.22,
        }, face));
        // Left cheek
        rois.push(clampRoi({
            x: x + w * 0.1,
            y: y + h * 0.35,
            w: w * 0.3,
            h: h * 0.25,
        }, face));
        // Right cheek
        rois.push(clampRoi({
            x: x + w * 0.6,
            y: y + h * 0.35,
            w: w * 0.3,
            h: h * 0.25,
        }, face));
        return rois.map((r) => ({
            x: Math.max(0, Math.floor(r.x)),
            y: Math.max(0, Math.floor(r.y)),
            w: Math.max(1, Math.floor(r.w)),
            h: Math.max(1, Math.floor(r.h)),
        }));
    }
    reportError(code, stage, cause) {
        const message = cause instanceof Error
            ? cause.message
            : stage === "face_mesh"
                ? "FaceMesh failed while processing a browser video frame."
                : "Failed to capture a browser video frame.";
        const error = {
            code,
            stage,
            message,
            timestampMs: Date.now(),
            cause,
        };
        this.lastError = error;
        this.onError?.(error);
    }
}
function clampRoi(roi, bounds) {
    const x = Math.max(bounds.x, Math.min(bounds.x + bounds.w - 1, roi.x));
    const y = Math.max(bounds.y, Math.min(bounds.y + bounds.h - 1, roi.y));
    const w = Math.max(1, Math.min(bounds.x + bounds.w - x, roi.w));
    const h = Math.max(1, Math.min(bounds.y + bounds.h - y, roi.h));
    return { x, y, w, h };
}
