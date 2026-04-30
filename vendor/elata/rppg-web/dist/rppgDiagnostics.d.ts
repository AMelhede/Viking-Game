import type { RppgTraceSnapshot } from "./rppgProcessor.js";
export interface WaveformPeriodicityProfile {
    minBpm: number;
    maxBpm: number;
    stepBpm: number;
    scores: number[];
    confidence: number;
    dominantBpm: number | null;
    dominantScore: number;
    secondaryBpm: number | null;
    secondaryScore: number;
    contrast: number;
    entropy: number;
    topCandidates: Array<{
        bpm: number;
        rawScore: number;
        posterior: number;
        lag: number;
    }>;
}
export interface RppgTraceWaveformDebug {
    points: Array<{
        time: number;
        value: number;
    }>;
    peaks: Array<{
        time: number;
        value: number;
    }>;
    sampleCount: number;
    durationSec: number;
    threshold: number | null;
    min: number | null;
    max: number | null;
    minPeakDistanceSamples: number;
}
export interface ComputeTraceWaveformDebugOptions {
    peakThresholdFactor?: number;
    minPeakDistanceSec?: number;
}
export declare function computeTraceWaveformDebug(trace: RppgTraceSnapshot, options?: ComputeTraceWaveformDebugOptions): RppgTraceWaveformDebug;
export declare function computeWaveformPeriodicityProfile(data: number[], sampleRate: number, minBpm?: number, maxBpm?: number, stepBpm?: number): WaveformPeriodicityProfile | null;
//# sourceMappingURL=rppgDiagnostics.d.ts.map