const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|access[-_]?token|secret|credential|password)/i;
const INLINE_SECRET_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\bsk-[A-Za-z0-9_-]{12,}/gi,
    /([?&](?:access_token|token|signature|sig|api_key|key|credential)=)[^&#\s"']+/gi,
];

/** 递归移除日志、响应快照和 Receipt 中可能出现的凭据。 */
export function redactSecrets(value: unknown): unknown {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (value && typeof value === "object") {
        const output: Record<string, unknown> = {};
        for (const [key, current] of Object.entries(value as Record<string, unknown>)) {
            output[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(current);
        }
        return output;
    }
    return value;
}

export function redactString(value: string): string {
    return INLINE_SECRET_PATTERNS.reduce(
        (current, pattern) => current.replace(pattern, (match, prefix?: string) => {
            if (match.startsWith("Bearer")) return "Bearer [REDACTED]";
            if (typeof prefix === "string") return `${prefix}[REDACTED]`;
            return "[REDACTED]";
        }),
        value,
    );
}

export function safeErrorDetails(error: unknown) {
    if (error instanceof Error) {
        return redactSecrets({
            name: error.name,
            message: error.message,
            cause: error.cause instanceof Error
                ? { name: error.cause.name, message: error.cause.message }
                : error.cause,
        });
    }
    return redactSecrets({ message: String(error) });
}
