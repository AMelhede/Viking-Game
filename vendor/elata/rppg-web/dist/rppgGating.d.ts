export type RppgGuidanceCode = "idle" | "no_face" | "increase_lighting" | "finding_pulse" | "calibrating" | "active_monitoring" | "motion_hold";
export type RppgGatingState = "idle" | "needs_face" | "needs_light" | "finding_pulse" | "calibrating" | "active" | "motion_hold";
export type RppgGatingInputs = {
    nowMs: number;
    metrics: {
        bpm?: number | null;
        confidence?: number;
        signal_quality?: number;
        reason_codes?: string[];
        skin_ratio_mean?: number;
        motion_mean?: number;
        clip_mean?: number;
        calibration_trained?: boolean;
        baseline_bpm?: number | null;
    };
    /**
     * If the host app already knows whether a face is detected (e.g. via
     * MediaPipe FaceMesh), pass it here to improve guidance accuracy.
     */
    hasFace?: boolean;
};
export type RppgGatingOptions = {
    /**
     * Motion gate threshold. Values are expected to be in [0, 1].
     * When motion is above this threshold, we enter a "motion hold" state.
     */
    motionGateThreshold?: number;
    /** Motion level that releases a motion hold early. */
    motionReleaseThreshold?: number;
    /** Minimum time to hold once the gate triggers. */
    motionHoldMs?: number;
    /** Minimum skin ratio to consider the ROI usable (heuristic). */
    minSkinRatio?: number;
    /** Below this, guidance will suggest more light (signal quality is [0, 1]). */
    minSignalQualityForPulse?: number;
    /** Below this, we avoid updating the stable BPM anchor. */
    minConfidenceForStable?: number;
    /** How long a stable BPM can be shown when metrics go null. */
    stableDisplayHoldMs?: number;
};
export type RppgGatingOutput = {
    state: RppgGatingState;
    guidance: {
        code: RppgGuidanceCode;
        message: string;
    };
    /** BPM that should be shown/used by the host app after gating. */
    publishBpm: number | null;
    /** True if we are currently holding a prior BPM due to motion. */
    holding: boolean;
    /** Debug details intended for logs / UI. */
    debug: {
        reasons: string[];
        motionHoldUntilMs: number | null;
        lastStableBpm: number | null;
        lastStableAtMs: number | null;
    };
};
/**
 * Framework-agnostic progressive gating for rPPG heart rate.
 *
 * The SDK already exposes raw metrics (`RppgProcessor.getMetrics()`), but apps
 * often need a stable, user-friendly "gated" BPM and actionable guidance.
 * This controller provides:
 * - Motion-hold gating (freeze BPM during high motion)
 * - Basic "face / light / pulse" guidance
 * - A stable BPM anchor that survives brief dropouts
 */
export declare class RppgGatingController {
    private readonly opts;
    private motionHoldUntilMs;
    private lastStableBpm;
    private lastStableAtMs;
    constructor(options?: RppgGatingOptions);
    reset(): void;
    update(input: RppgGatingInputs): RppgGatingOutput;
}
//# sourceMappingURL=rppgGating.d.ts.map