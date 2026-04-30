import type { RppgSessionDiagnostics } from "./rppgSession.js";
export type RppgNormalizedErrorCode = "wasm_init_failed" | "face_tracking_init_failed" | "camera_not_playing" | "capture_failed" | "canvas_unavailable" | "processor_failed" | "backend_unavailable" | "startup_failed" | "runtime_failed";
export type RppgNormalizedError = {
    code: RppgNormalizedErrorCode;
    phase: "startup" | "runtime";
    message: string;
    detail: string;
    guidance: string;
    retryable: boolean;
    terminal: boolean;
};
type DiagnosticsLike = Partial<Pick<RppgSessionDiagnostics, "backendMode" | "state" | "lastError">>;
export declare function normalizeRppgError(error?: unknown, diagnostics?: DiagnosticsLike | null): RppgNormalizedError | null;
export {};
//# sourceMappingURL=rppgErrors.d.ts.map