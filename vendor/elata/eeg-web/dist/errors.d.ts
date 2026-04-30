export type ElataErrorDetails = Record<string, unknown>;
export declare class ElataError extends Error {
    readonly code: string;
    readonly details?: ElataErrorDetails;
    readonly recoverable?: boolean;
    readonly cause?: unknown;
    constructor(code: string, message: string, options?: {
        cause?: unknown;
        details?: ElataErrorDetails;
        recoverable?: boolean;
    });
}
export declare function isElataError(value: unknown): value is ElataError;
export declare function asElataError(value: unknown, fallback?: {
    code: string;
    message: string;
    details?: ElataErrorDetails;
}): ElataError;
//# sourceMappingURL=errors.d.ts.map