import crypto from "node:crypto";
import fs from "node:fs";

export const TTS_TEXT_NORMALIZER_VERSION = "tts-text-normalizer/1";

/** 按键名递归排序，生成用于哈希的稳定 JSON。 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

/** 对规范化 JSON 计算 SHA-256。 */
export function canonicalJsonSha256(value: unknown): string {
    return sha256(canonicalJson(value));
}

/** 对字符串或二进制数据计算 SHA-256。 */
export function sha256(value: string | Uint8Array): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

/** 对文件内容计算 SHA-256。 */
export function sha256File(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

/** 只处理不会改变朗读语义的文本差异，并显式绑定规则版本。 */
export function normalizeTtsText(text: string): string {
    return text
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .normalize("NFKC")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/g, ""))
        .join("\n")
        .trim();
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("规范化 JSON 不接受 NaN 或 Infinity");
        return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value === "object") {
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const current = (value as Record<string, unknown>)[key];
            if (current !== undefined) output[key] = canonicalize(current);
        }
        return output;
    }
    throw new TypeError(`无法规范化 JSON 值：${typeof value}`);
}
