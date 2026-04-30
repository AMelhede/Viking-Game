import type { WaveformPeriodicityProfile } from "./rppgDiagnostics.js";
export type TrackerSource = "peaks" | "acf" | "spectral";
export type HarmonicMode = "half" | "fundamental" | "double";
export type TrackerReferenceOrigin = "none" | "session_pair" | "snapshot_restore";
export interface EstimatorMeasurement {
    source: TrackerSource;
    bpm: number | null;
    confidence: number;
}
export interface TrackerContext {
    motion: number;
    snrDb: number;
    quality: number;
    referenceBpm?: number;
    referenceStrength?: number;
    referenceAgeSec?: number;
    waveformProfile?: WaveformPeriodicityProfile | null;
}
export interface TrackerEstimate {
    bpm: number | null;
    confidence: number;
    modeProbabilities: Record<HarmonicMode, number>;
    entropy: number;
}
export interface BpmBayesSnapshot {
    minBpm: number;
    maxBpm: number;
    stepBpm: number;
    posterior: number[];
    sourceReliability: Record<TrackerSource, number>;
    sourceHarmonicConfusion: Record<TrackerSource, number>;
    referencePriorBpm?: number | null;
    referencePriorWeight?: number;
    harmonicPrior?: Record<HarmonicMode, number>;
    referencePriorOrigin?: TrackerReferenceOrigin;
    referencePriorLastUpdatedTs?: number | null;
    waveformReliability?: number;
}
export interface TrackerReferenceState {
    bpm: number | null;
    weight: number;
    harmonicPrior: Record<HarmonicMode, number>;
    origin: TrackerReferenceOrigin;
    lastUpdatedTs: number | null;
    waveformReliability: number;
}
export declare class BpmBayesTracker {
    private readonly minBpm;
    private readonly maxBpm;
    private readonly stepBpm;
    private readonly bpmGrid;
    private posterior;
    private sourceReliability;
    private sourceHarmonicConfusion;
    private referencePriorBpm;
    private referencePriorWeight;
    private harmonicPrior;
    private referencePriorOrigin;
    private referencePriorLastUpdatedTs;
    private waveformReliability;
    constructor(minBpm?: number, maxBpm?: number, stepBpm?: number);
    reset(): void;
    update(measurements: EstimatorMeasurement[], dtSec: number, context: TrackerContext): TrackerEstimate;
    observeReference(referenceBpm: number, strength?: number, _measurements?: EstimatorMeasurement[]): void;
    reinforceReference(referenceBpm: number, measurements: EstimatorMeasurement[], strength?: number, updatedAtTs?: number, waveformProfile?: WaveformPeriodicityProfile | null): void;
    reinforceHarmonicReference(referenceBpm: number, measurements: EstimatorMeasurement[], strength?: number, updatedAtTs?: number, waveformProfile?: WaveformPeriodicityProfile | null): void;
    updateReliability(referenceBpm: number, measurements: EstimatorMeasurement[]): void;
    getSnapshot(): BpmBayesSnapshot;
    getReferenceState(): TrackerReferenceState;
    loadSnapshot(snapshot: unknown): void;
    private toIndex;
    private applyTemporalPrior;
    private estimate;
    private normalize;
    private applyWaveformEvidence;
    private updateWaveformReliability;
    private estimateWaveformAgreement;
    private applyPersistentReferencePrior;
    private inferReferenceModeWeights;
}
//# sourceMappingURL=bpmBayesTracker.d.ts.map