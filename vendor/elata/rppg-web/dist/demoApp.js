import { createRppgSession } from "./rppgSession.js";
export async function initDemo(videoEl, opts = {}) {
    const session = await createRppgSession({
        video: videoEl,
        backend: "auto",
        faceMesh: "auto",
        enableTracker: { minBpm: 55, maxBpm: 150, numParticles: 200 },
        roiSmoothingAlpha: 0.25,
        useSkinMask: true,
        ...opts,
    });
    const { source, processor: proc, runner } = session;
    // expose info for debugging
    window.__rppg_demo = {
        source,
        proc,
        runner,
        session,
        backendAvailable: session.backendMode === "wasm",
    };
    return { source, proc, runner, session };
}
