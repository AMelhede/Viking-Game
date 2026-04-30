export class ElataError extends Error {
    constructor(code, message, options) {
        super(message);
        this.name = "ElataError";
        this.code = code;
        this.details = options?.details;
        this.recoverable = options?.recoverable;
        this.cause = options?.cause;
    }
}
export function isElataError(value) {
    return (typeof value === "object" &&
        value !== null &&
        value.name === "ElataError" &&
        typeof value.code === "string");
}
export function asElataError(value, fallback = {
    code: "UNKNOWN",
    message: "Unknown error",
}) {
    if (isElataError(value))
        return value;
    if (value instanceof Error) {
        return new ElataError(fallback.code, fallback.message, {
            cause: value,
            details: { ...(fallback.details || {}), originalMessage: value.message },
        });
    }
    return new ElataError(fallback.code, fallback.message, {
        details: { ...(fallback.details || {}), original: value },
    });
}
