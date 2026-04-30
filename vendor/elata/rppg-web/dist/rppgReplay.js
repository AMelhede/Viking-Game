import { BpmBayesTracker, } from "./bpmBayesTracker.js";
import { computeWaveformPeriodicityProfile } from "./rppgDiagnostics.js";
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function mean(values) {
    if (!values.length)
        return null;
    return values.reduce((acc, value) => acc + value, 0) / values.length;
}
function mae(values, reference) {
    const valid = values.filter((value) => value != null && Number.isFinite(value));
    if (!valid.length)
        return null;
    return (valid.reduce((acc, value) => acc + Math.abs(value - reference), 0) /
        valid.length);
}
function parseCandidateSummary(summary) {
    if (!summary)
        return {};
    const parsed = {};
    for (const part of summary.split("|")) {
        const trimmed = part.trim();
        const match = /^(peaks|acf|spectral):[-+0-9.]+@([-+0-9.]+)$/.exec(trimmed);
        if (!match)
            continue;
        parsed[match[1]] = clamp(Number(match[2]), 0, 1);
    }
    return parsed;
}
function safeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function inferMeasurements(sample) {
    const estimators = sample.estimators ?? {};
    const candidateConfidence = parseCandidateSummary(estimators.candidateSummary ?? null);
    const peaksCount = Array.isArray(sample.peaks) ? sample.peaks.length : 0;
    const peakConfidence = clamp(safeNumber(estimators.peakConfidence) ??
        candidateConfidence.peaks ??
        clamp(peaksCount / 12, 0.05, 1), 0, 1);
    const cameraConfidence = clamp(safeNumber(estimators.cameraConfidence) ?? 0, 0, 1);
    const acfConfidence = clamp(safeNumber(estimators.acfConfidence) ??
        candidateConfidence.acf ??
        (safeNumber(estimators.acfBpm) != null
            ? clamp(cameraConfidence * 0.9, 0.1, 0.75)
            : 0), 0, 1);
    const spectralConfidence = clamp(safeNumber(estimators.spectralConfidence) ??
        candidateConfidence.spectral ??
        (safeNumber(estimators.spectralBpm) != null
            ? clamp(cameraConfidence * 0.7, 0.08, 0.65)
            : 0), 0, 1);
    return [
        {
            source: "peaks",
            bpm: safeNumber(estimators.instantBpm),
            confidence: peakConfidence,
        },
        {
            source: "acf",
            bpm: safeNumber(estimators.acfBpm),
            confidence: acfConfidence,
        },
        {
            source: "spectral",
            bpm: safeNumber(estimators.spectralBpm),
            confidence: spectralConfidence,
        },
    ];
}
export function replayBayesSession(session, options) {
    const syncSamples = [...session.syncSamples].sort((a, b) => a.epochTs - b.epochTs);
    const pairEvents = [...(session.pairEvents ?? [])]
        .filter((event) => Number.isFinite(event.ts) && Number.isFinite(event.referenceBpm))
        .sort((a, b) => a.ts - b.ts);
    const tracker = new BpmBayesTracker(40, 180, 1);
    const points = [];
    let prevTs = 0;
    let pairIndex = 0;
    let latestReferenceBpm = null;
    for (const sample of syncSamples) {
        const measurements = inferMeasurements(sample);
        while (pairIndex < pairEvents.length &&
            pairEvents[pairIndex].ts <= sample.epochTs) {
            latestReferenceBpm = pairEvents[pairIndex].referenceBpm;
            tracker.reinforceReference(latestReferenceBpm, measurements, 1, pairEvents[pairIndex].ts);
            pairIndex += 1;
        }
        const dtSec = prevTs > 0
            ? clamp((sample.epochTs - prevTs) / 1000, 0.03, 0.7)
            : 0.1;
        prevTs = sample.epochTs;
        const estimators = sample.estimators ?? {};
        const waveformValues = sample.museWindow?.values ?? sample.filteredWindow?.values ?? null;
        const waveformProfile = Array.isArray(waveformValues) && waveformValues.length
            ? computeWaveformPeriodicityProfile(waveformValues.filter((value) => typeof value === "number" && Number.isFinite(value)), safeNumber(sample.sampleRate) ?? 0, 40, 180, 1)
            : null;
        const replayEstimate = tracker.update(measurements, dtSec, {
            motion: clamp(safeNumber(estimators.motion) ?? 0, 0, 1),
            snrDb: safeNumber(estimators.snrDb) ?? 0,
            quality: clamp((sample.outputs?.signalQuality ?? 0) / 100, 0, 1),
            waveformProfile,
        });
        points.push({
            ts: sample.epochTs,
            stage: sample.stage ?? "unknown",
            replayBayesBpm: replayEstimate.bpm,
            replayBayesConfidence: replayEstimate.confidence,
            recordedBayesBpm: safeNumber(estimators.bayesBpm),
            recordedBayesConfidence: safeNumber(estimators.bayesConfidence),
            recordedFinalBpm: safeNumber(estimators.finalBpm),
            referenceBpm: latestReferenceBpm,
        });
    }
    const pairWindowMs = options?.pairWindowMs ?? 20000;
    const pairSummaries = pairEvents.map((event) => {
        const windowPoints = points.filter((point) => point.ts >= event.ts && point.ts <= event.ts + pairWindowMs);
        return {
            referenceBpm: event.referenceBpm,
            pairTs: event.ts,
            windowMs: pairWindowMs,
            points: windowPoints.length,
            recordedBayesMae: mae(windowPoints.map((point) => point.recordedBayesBpm), event.referenceBpm),
            replayBayesMae: mae(windowPoints.map((point) => point.replayBayesBpm), event.referenceBpm),
            recordedFinalMae: mae(windowPoints.map((point) => point.recordedFinalBpm), event.referenceBpm),
            replayMeanBpm: mean(windowPoints
                .map((point) => point.replayBayesBpm)
                .filter((value) => value != null)),
            recordedMeanBpm: mean(windowPoints
                .map((point) => point.recordedBayesBpm)
                .filter((value) => value != null)),
        };
    });
    return {
        schema: pairEvents.length
            ? "rppg-bayes-replay/v1"
            : "rppg-bayes-replay/no-pairs",
        points,
        pairSummaries,
    };
}
