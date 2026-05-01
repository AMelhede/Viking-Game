export class MediaPipeFrameSource {
    constructor(video, opts = {}) {
        this.video = video;
        this.opts = opts;
        this.onFrame = null;
        this.onError = null;
        this.running = false;
        this.timer = null;
        this.vfcHandle = null;
        this.lastError = null;
        // create an offscreen canvas
        this.canvas = document.createElement("canvas");
        this.canvas.width = video.videoWidth || video.width || 320;
        this.canvas.height = video.videoHeight || video.height || 240;
        const ctx = this.canvas.getContext("2d", {
            willReadFrequently: true,
        });
        if (!ctx)
            throw new Error("2D context unavailable");
        this.ctx = ctx;
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        const fps = this.opts.fps || 30;
        const interval = 1000 / fps;
        const vfc = this.video.requestVideoFrameCallback;
        if (typeof vfc === "function") {
            const cb = (now, metadata) => {
                if (!this.running)
                    return;
                this.captureFrame(now, metadata);
                this.vfcHandle = this.video.requestVideoFrameCallback(cb);
            };
            this.vfcHandle = this.video.requestVideoFrameCallback(cb);
        }
        else {
            this.timer = setInterval(() => this.captureFrame(Date.now(), null), interval);
        }
    }
    async stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        const cancel = this.video.cancelVideoFrameCallback;
        if (this.vfcHandle !== null && typeof cancel === "function") {
            cancel.call(this.video, this.vfcHandle);
            this.vfcHandle = null;
        }
    }
    getLastError() {
        return this.lastError;
    }
    captureFrame(now, metadata) {
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
            if (this.onFrame)
                this.onFrame(frame);
        }
        catch (error) {
            this.reportError("capture_failed", "capture", error);
        }
    }
    reportError(code, stage, cause) {
        const message = cause instanceof Error
            ? cause.message
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
