async function defaultImporter(url) {
    return import(/* @vite-ignore */ url);
}
function hasPipelineMethods(value) {
    if (!value || typeof value !== "object")
        return false;
    const pipeline = value;
    return (typeof pipeline.push_sample === "function" ||
        typeof pipeline.pushSample === "function" ||
        typeof pipeline.push_sample_rgb === "function" ||
        typeof pipeline.pushSampleRgb === "function" ||
        typeof pipeline.push_sample_rgb_meta === "function" ||
        typeof pipeline.pushSampleRgbMeta === "function") &&
        (typeof pipeline.get_metrics === "function" ||
            typeof pipeline.getMetrics === "function");
}
function normalizePipelineInstance(instance, module) {
    if (hasPipelineMethods(instance))
        return instance;
    if (!instance || typeof instance !== "object")
        return instance;
    const prototypeCandidates = [
        module.WasmRppgPipeline?.prototype,
        module.RppgPipeline?.prototype,
    ];
    for (const prototype of prototypeCandidates) {
        if (prototype &&
            (hasPipelineMethods(prototype) || typeof prototype.free === "function")) {
            Object.setPrototypeOf(instance, prototype);
            if (hasPipelineMethods(instance)) {
                return instance;
            }
        }
    }
    return instance;
}
function createNormalizedPipelineFactory(module, Constructor) {
    return (sampleRate, windowSec) => normalizePipelineInstance(new Constructor(sampleRate, windowSec), module);
}
export class RppgWasmLoadError extends Error {
    constructor(attemptedUrls, lastError) {
        super(`Unable to load rPPG WASM backend. Tried: ${attemptedUrls.join(", ")}. Set up the bundle so one of these URLs resolves.`);
        this.code = "RPPG_WASM_LOAD_FAILED";
        this.name = "RppgWasmLoadError";
        this.attemptedUrls = attemptedUrls;
        this.lastError = lastError;
    }
}
// Try to dynamically import the wasm JS bundle from a few common locations
export async function loadWasmBackend(importer = defaultImporter, options = {}) {
    const candidates = options.jsUrl
        ? [options.jsUrl]
        : options.candidateUrls && options.candidateUrls.length > 0
            ? options.candidateUrls
            : [
                "/pkg/rppg_wasm.js",
                "/pkg/eeg_wasm.js",
                "/rppg_wasm.js",
                "/eeg_wasm.js",
            ];
    let lastError = undefined;
    for (const url of candidates) {
        try {
            const mod = await importer(url);
            // wasm-bindgen bundles export a default init function; call it before using constructors.
            if (typeof mod.default === "function") {
                if (options.binaryUrl) {
                    await mod.default(options.binaryUrl);
                }
                else {
                    await mod.default();
                }
            }
            const Constructor = mod.RppgPipeline ??
                mod.WasmRppgPipeline ??
                mod.default?.RppgPipeline ??
                mod.default?.WasmRppgPipeline;
            if (Constructor) {
                return {
                    newPipeline: createNormalizedPipelineFactory(mod, Constructor),
                };
            }
            // Some bundles expose constructor directly as default
            if (mod.default && typeof mod.default === "function") {
                return {
                    newPipeline: (sr, ws) => new mod.default(sr, ws),
                };
            }
        }
        catch (e) {
            lastError = e;
        }
    }
    if (options.strict) {
        throw new RppgWasmLoadError(candidates, lastError);
    }
    return null;
}
export function createUnavailableBackend() {
    return {
        newPipeline: () => ({
            push_sample: () => { },
            get_metrics: () => ({ bpm: null, confidence: 0, signal_quality: 0 }),
        }),
    };
}
