import initWasm, { initSync as initSyncWasm } from "../wasm/eeg_wasm.js";
import * as wasm from "../wasm/eeg_wasm.js";
let initPromise = null;
function isPlainObject(value) {
    return (value !== null &&
        typeof value === "object" &&
        Object.getPrototypeOf(value) === Object.prototype);
}
function normalizeInitEegWasmInput(moduleOrPath) {
    if (moduleOrPath === undefined)
        return undefined;
    if (isPlainObject(moduleOrPath) && "module_or_path" in moduleOrPath) {
        return moduleOrPath;
    }
    return { module_or_path: moduleOrPath };
}
function normalizeInitEegWasmSyncInput(module) {
    if (isPlainObject(module) && "module" in module) {
        return module;
    }
    return { module };
}
export async function initEegWasm(moduleOrPath) {
    if (!initPromise) {
        initPromise = initWasm(normalizeInitEegWasmInput(moduleOrPath));
    }
    return initPromise;
}
export function initEegWasmSync(module) {
    return initSyncWasm(normalizeInitEegWasmSyncInput(module));
}
export function createRppgPipeline(sampleRate, windowSec) {
    const Constructor = wasm.WasmRppgPipeline ?? wasm.RppgPipeline;
    if (typeof Constructor !== "function") {
        throw new Error("rPPG pipeline constructor is not available in eeg-web.");
    }
    const instance = new Constructor(sampleRate, windowSec);
    const prototypeCandidates = [
        wasm.WasmRppgPipeline?.prototype,
        wasm.RppgPipeline?.prototype,
    ];
    if (typeof instance?.push_sample !== "function" ||
        typeof instance?.get_metrics !== "function") {
        for (const prototype of prototypeCandidates) {
            if (!prototype)
                continue;
            Object.setPrototypeOf(instance, prototype);
            if (typeof instance?.push_sample === "function" &&
                typeof instance?.get_metrics === "function") {
                break;
            }
        }
    }
    if (typeof instance?.push_sample !== "function" ||
        typeof instance?.get_metrics !== "function") {
        throw new Error("Unable to normalize the eeg-web rPPG pipeline export.");
    }
    return instance;
}
export * from "./headband.js";
export * from "./errors.js";
// Compatibility export for advanced/debug use. Prefer the wrapper helpers above
// in app code so consumers stay on the normalized init and pipeline paths.
export * from "../wasm/eeg_wasm.js";
export { wasm };
