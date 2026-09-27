import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WordTimestamp } from "./schemas.js";
import { WordTimestampSchema } from "./schemas.js";
import { retimeToNarrationTokens, stripSpeechControls, tokenizeNarration } from "./tokenization.js";

export type AlignmentValidationThresholds = {
    minimumCoverage: number;
    maximumEndOverrunSamples: number;
    maximumOverlapRatio: number;
    maximumUnexpectedGapSamples: number;
};

export type AlignmentValidationReport = {
    valid: boolean;
    score: number;
    coverage: number;
    monotonicity: number;
    overlap_ratio: number;
    end_overrun_samples: number;
    unexpected_gap_count: number;
    timestamp_count: number;
    reasons: string[];
};

export type AlignmentResult = {
    words: WordTimestamp[];
    alignment_source: "minimax_word" | "local_forced_alignment";
    fallback_used: boolean;
    fallback_reason?: string;
    validation_score: number;
    report: {
        provider: AlignmentValidationReport;
        fallback?: AlignmentValidationReport;
    };
};

export type ForcedAlignmentInput = {
    segmentId?: string;
    audioPath: string;
    text: string;
    sampleRate: number;
    audioDurationSamples: number;
};

export type ForcedAlignerIdentity = {
    name: string;
    model?: string;
    model_revision?: string;
    package_version?: string;
    device?: string;
    config?: Record<string, unknown>;
};

export interface ForcedAligner {
    align(input: ForcedAlignmentInput): Promise<WordTimestamp[]>;
    identity?(): ForcedAlignerIdentity | Promise<ForcedAlignerIdentity>;
}

export type ShadowAsrResult = {
    schema_version: string;
    backend: {
        name: string;
        model: string;
        device: string;
        compute_type?: string;
    };
    language: string;
    language_probability: number;
    recognized_text: string;
    text_similarity: number;
    segments: unknown[];
    diagnostic_only: true;
};

export interface ShadowAsrProbe {
    shadowAsr(input: ForcedAlignmentInput): Promise<ShadowAsrResult>;
}

export const DEFAULT_ALIGNMENT_THRESHOLDS: AlignmentValidationThresholds = {
    minimumCoverage: 0.98,
    maximumEndOverrunSamples: 4_800,
    maximumOverlapRatio: 0.01,
    maximumUnexpectedGapSamples: 96_000,
};

/** 将 MiniMax 字幕文件中常见的毫秒/秒/采样格式统一成 48 kHz 采样位置。 */
export function normalizeProviderTimestamps(raw: unknown, sampleRate = 48_000): WordTimestamp[] {
    const parsed = typeof raw === "string" ? tryParseJson(raw) : raw;
    const entries = findTimestampEntries(parsed);
    if (!entries) return [];
    const rootUnit = getStringField(parsed, ["time_unit", "unit"]);
    const words: WordTimestamp[] = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const text = getStringField(record, ["text", "word", "token", "content"]);
        if (!text) continue;
        const timing = readTiming(record, rootUnit, sampleRate);
        if (!timing) continue;
        const candidate = {
            index: words.length,
            text,
            start_sample: timing.start,
            end_sample: timing.end,
        };
        const result = WordTimestampSchema.safeParse(candidate);
        if (result.success) words.push(result.data);
    }
    return words;
}

/** 对词级时间戳执行覆盖率、顺序、越界、重叠和异常空洞质量门。 */
export function validateAlignment(
    sourceText: string,
    words: WordTimestamp[],
    audioDurationSamples: number,
    thresholds: AlignmentValidationThresholds = DEFAULT_ALIGNMENT_THRESHOLDS,
): AlignmentValidationReport {
    const reasons: string[] = [];
    const sourceComparable = normalizeAlignmentText(sourceText);
    const timestampComparable = normalizeAlignmentText(words.map((word) => word.text).join(""));
    const coverage = textSimilarity(sourceComparable, timestampComparable);
    if (coverage < thresholds.minimumCoverage) reasons.push("provider_token_coverage_below_threshold");

    let monotonicPairs = 0;
    let overlapCount = 0;
    let unexpectedGapCount = 0;
    const allowedPauseSamples = largestDeclaredPauseSamples(sourceText);
    for (let index = 0; index < words.length; index += 1) {
        const current = words[index];
        if (current.start_sample < 0 || current.end_sample <= current.start_sample) {
            reasons.push("invalid_or_negative_timestamp");
        }
        if (index === 0) continue;
        const previous = words[index - 1];
        if (current.start_sample >= previous.start_sample && current.end_sample >= previous.end_sample) monotonicPairs += 1;
        if (current.start_sample < previous.end_sample) overlapCount += 1;
        const gap = current.start_sample - previous.end_sample;
        const permittedGap = Math.max(thresholds.maximumUnexpectedGapSamples, allowedPauseSamples + 12_000);
        if (gap > permittedGap) unexpectedGapCount += 1;
    }

    const pairCount = Math.max(0, words.length - 1);
    const monotonicity = pairCount === 0 ? (words.length > 0 ? 1 : 0) : monotonicPairs / pairCount;
    const overlapRatio = words.length === 0 ? 1 : overlapCount / words.length;
    if (monotonicity < 1) reasons.push("timestamps_not_monotonic");
    if (overlapRatio > thresholds.maximumOverlapRatio) reasons.push("timestamp_overlap_above_threshold");
    if (unexpectedGapCount > 0) reasons.push("unexpected_timestamp_gap");

    const lastEnd = words.reduce((maximum, word) => Math.max(maximum, word.end_sample), 0);
    const endOverrunSamples = Math.max(0, lastEnd - audioDurationSamples);
    if (endOverrunSamples > thresholds.maximumEndOverrunSamples) reasons.push("timestamp_exceeds_audio_duration");
    if (words.length === 0) reasons.push("provider_timestamps_missing");
    if (sourceComparable.length >= 8 && words.length === 1) reasons.push("provider_returned_sentence_not_word_timestamps");

    const score = Math.max(0, Math.min(
        coverage,
        monotonicity,
        1 - Math.min(1, overlapRatio),
        endOverrunSamples <= thresholds.maximumEndOverrunSamples ? 1 : 0,
        unexpectedGapCount === 0 ? 1 : 0,
    ));
    return {
        valid: reasons.length === 0,
        score,
        coverage,
        monotonicity,
        overlap_ratio: overlapRatio,
        end_overrun_samples: endOverrunSamples,
        unexpected_gap_count: unexpectedGapCount,
        timestamp_count: words.length,
        reasons: [...new Set(reasons)],
    };
}

/** 优先采用通过质量门的 Provider 时间戳，否则调用已配置的本地强制对齐器。 */
export async function resolveAlignment(input: {
    sourceText: string;
    providerTimestamps: unknown;
    audioPath: string;
    audioDurationSamples: number;
    segmentId?: string;
    forcedAligner?: ForcedAligner;
    thresholds?: AlignmentValidationThresholds;
}): Promise<AlignmentResult> {
    const providerWords = normalizeProviderTimestamps(input.providerTimestamps);
    const providerReport = validateAlignment(
        input.sourceText,
        providerWords,
        input.audioDurationSamples,
        input.thresholds,
    );
    if (providerReport.valid) {
        const canonicalWords = retimeToNarrationTokens(input.sourceText, providerWords);
        return {
            words: canonicalWords,
            alignment_source: "minimax_word",
            fallback_used: false,
            validation_score: providerReport.score,
            report: { provider: providerReport },
        };
    }
    if (!input.forcedAligner) {
        throw new AlignmentFallbackRequiredError(providerReport);
    }

    const rawFallbackWords = await input.forcedAligner.align({
        segmentId: input.segmentId,
        audioPath: input.audioPath,
        text: input.sourceText,
        sampleRate: 48_000,
        audioDurationSamples: input.audioDurationSamples,
    });
    const fallbackReport = validateAlignment(
        input.sourceText,
        rawFallbackWords,
        input.audioDurationSamples,
        input.thresholds,
    );
    if (!fallbackReport.valid) {
        throw new Error(`本地强制对齐未通过质量门：${fallbackReport.reasons.join(", ")}`);
    }
    const fallbackWords = retimeToNarrationTokens(input.sourceText, rawFallbackWords);
    return {
        words: fallbackWords,
        alignment_source: "local_forced_alignment",
        fallback_used: true,
        fallback_reason: providerReport.reasons[0] || "provider_timestamp_validation_failed",
        validation_score: fallbackReport.score,
        report: { provider: providerReport, fallback: fallbackReport },
    };
}

export class AlignmentFallbackRequiredError extends Error {
    readonly report: AlignmentValidationReport;

    constructor(report: AlignmentValidationReport) {
        super(`Provider 时间戳未通过质量门，且未配置本地强制对齐器：${report.reasons.join(", ")}`);
        this.name = "AlignmentFallbackRequiredError";
        this.report = report;
    }
}

/**
 * 通过中立 JSON 协议调用隔离进程中的本地对齐器。
 */
export class CommandForcedAligner implements ForcedAligner, ShadowAsrProbe {
    private identityPromise?: Promise<ForcedAlignerIdentity>;

    constructor(private readonly executable: string, private readonly extraArgs: string[] = []) {}

    identity() {
        this.identityPromise ||= this.loadIdentity();
        return this.identityPromise;
    }

    async align(input: ForcedAlignmentInput): Promise<WordTimestamp[]> {
        const { result, tokens } = await this.runCommand("align", input) as {
            result: {
                tokens?: Array<{
                    token_id?: unknown;
                    start_sample?: unknown;
                    end_sample?: unknown;
                }>;
            };
            tokens: string[];
        };
        if (!Array.isArray(result.tokens) || result.tokens.length !== tokens.length) {
            throw new Error(`本地对齐结果词元数量不一致：期望 ${tokens.length}，实际 ${result.tokens?.length ?? 0}`);
        }
        return result.tokens.map((token, index) => WordTimestampSchema.parse({
            index,
            text: tokens[index],
            start_sample: token.start_sample,
            end_sample: token.end_sample,
        }));
    }

    async shadowAsr(input: ForcedAlignmentInput): Promise<ShadowAsrResult> {
        const { result } = await this.runCommand("shadow-asr", input) as {
            result: Partial<ShadowAsrResult>;
        };
        if (result.diagnostic_only !== true
            || typeof result.text_similarity !== "number"
            || !result.backend?.name
            || !Array.isArray(result.segments)) {
            throw new Error("本地对齐程序返回的 shadow-asr 结果无效");
        }
        return result as ShadowAsrResult;
    }

    private async runCommand(command: "align" | "shadow-asr", input: ForcedAlignmentInput) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-align-"));
        const requestPath = path.join(directory, "request.json");
        const outputPath = path.join(directory, "result.json");
        const tokens = tokenizeNarration(input.text);
        try {
            fs.writeFileSync(
                requestPath,
                JSON.stringify(buildAlignerRequest(input, tokens), null, 2),
                "utf8",
            );
            await runAlignerProcess(this.executable, [
                ...this.extraArgs,
                command,
                requestPath,
                outputPath,
            ]);
            if (!fs.existsSync(outputPath)) throw new Error("本地对齐程序未生成输出文件");
            return {
                result: JSON.parse(fs.readFileSync(outputPath, "utf8")) as unknown,
                tokens,
            };
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }

    private async loadIdentity(): Promise<ForcedAlignerIdentity> {
        const stdout = await runAlignerProcess(this.executable, [...this.extraArgs, "doctor", "--json"]);
        const result = JSON.parse(stdout) as {
            cache_identity?: ForcedAlignerIdentity;
            backend?: ForcedAlignerIdentity;
        };
        const identity = result.cache_identity || result.backend;
        if (!identity?.name) throw new Error("本地对齐器 doctor 未返回 cache_identity");
        return identity;
    }
}

function buildAlignerRequest(input: ForcedAlignmentInput, tokens: string[]) {
    const segmentId = input.segmentId || "SEG";
    return {
        schema_version: "1",
        backend: "whisperx",
        audio_path: path.resolve(input.audioPath),
        language: "zh",
        text: input.text,
        stable_tokens: tokens.map((text, index) => ({
            id: `${segmentId}:T${String(index + 1).padStart(4, "0")}`,
            text,
        })),
        segment: {
            start_sample: 0,
            end_sample: input.audioDurationSamples,
        },
        options: {
            device: process.env.LOCAL_ALIGNER_DEVICE || "cuda",
            return_char_alignments: true,
            model_cache_only:
                process.env.LOCAL_ALIGNER_MODEL_CACHE_ONLY === "1",
        },
    };
}

function findTimestampEntries(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    for (const key of ["words", "word_timestamps", "timestamps", "subtitles", "segments", "data"]) {
        const candidate = record[key];
        if (Array.isArray(candidate)) return candidate;
        const nested = findTimestampEntries(candidate);
        if (nested) return nested;
    }
    return undefined;
}

function readTiming(record: Record<string, unknown>, rootUnit: string | undefined, sampleRate: number) {
    const startSample = getNumberField(record, ["start_sample", "begin_sample"]);
    const endSample = getNumberField(record, ["end_sample", "finish_sample"]);
    if (startSample !== undefined && endSample !== undefined) {
        return { start: Math.round(startSample), end: Math.round(endSample) };
    }

    const startSeconds = getNumberField(record, ["start_seconds", "begin_seconds"]);
    const endSeconds = getNumberField(record, ["end_seconds", "finish_seconds"]);
    if (startSeconds !== undefined && endSeconds !== undefined) {
        return { start: Math.round(startSeconds * sampleRate), end: Math.round(endSeconds * sampleRate) };
    }

    const startMilliseconds = getNumberField(record, ["start_ms", "begin_ms", "start_time", "begin_time"]);
    let endMilliseconds = getNumberField(record, ["end_ms", "finish_ms", "end_time", "finish_time"]);
    if (startMilliseconds !== undefined) {
        const duration = getNumberField(record, ["duration_ms", "duration"]);
        if (endMilliseconds === undefined && duration !== undefined) endMilliseconds = startMilliseconds + duration;
        if (endMilliseconds !== undefined) {
            return {
                start: Math.round(startMilliseconds * sampleRate / 1_000),
                end: Math.round(endMilliseconds * sampleRate / 1_000),
            };
        }
    }

    const unit = (getStringField(record, ["time_unit", "unit"]) || rootUnit || "").toLowerCase();
    const start = getNumberField(record, ["start", "begin"]);
    let end = getNumberField(record, ["end", "finish"]);
    if (start === undefined) return undefined;
    const duration = getNumberField(record, ["duration"]);
    if (end === undefined && duration !== undefined) end = start + duration;
    if (end === undefined) return undefined;
    if (unit.includes("sample")) return { start: Math.round(start), end: Math.round(end) };
    if (unit.includes("sec") && !unit.includes("ms")) {
        return { start: Math.round(start * sampleRate), end: Math.round(end * sampleRate) };
    }
    if (unit.includes("ms") || unit.includes("milli")) {
        return { start: Math.round(start * sampleRate / 1_000), end: Math.round(end * sampleRate / 1_000) };
    }
    return undefined;
}

function normalizeAlignmentText(value: string) {
    return stripSpeechControls(value)
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[\p{P}\p{S}\s]/gu, "");
}

function textSimilarity(first: string, second: string) {
    if (first === second) return 1;
    if (!first || !second) return 0;
    const longest = Math.max(first.length, second.length);
    if (longest > 4_000) return greedySequenceCoverage(first, second);
    const previous = new Uint32Array(second.length + 1);
    const current = new Uint32Array(second.length + 1);
    for (let index = 0; index <= second.length; index += 1) previous[index] = index;
    for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
        current[0] = firstIndex;
        for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
            const substitution = previous[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1);
            current[secondIndex] = Math.min(previous[secondIndex] + 1, current[secondIndex - 1] + 1, substitution);
        }
        previous.set(current);
    }
    return 1 - previous[second.length] / longest;
}

function greedySequenceCoverage(first: string, second: string) {
    let firstIndex = 0;
    let matched = 0;
    for (const character of second) {
        const found = first.indexOf(character, firstIndex);
        if (found < 0) continue;
        matched += 1;
        firstIndex = found + 1;
    }
    return matched / Math.max(first.length, second.length);
}

function largestDeclaredPauseSamples(text: string) {
    let maximumSeconds = 0;
    for (const match of text.matchAll(/<#([0-9]+(?:\.[0-9]+)?)#>/g)) {
        maximumSeconds = Math.max(maximumSeconds, Number(match[1]));
    }
    return Math.round(maximumSeconds * 48_000);
}

function getStringField(value: unknown, keys: string[]) {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
    return undefined;
}

function getNumberField(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
    return undefined;
}

function tryParseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}

function runAlignerProcess(executable: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (stdout.length < 1_000_000) stdout += chunk;
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            if (stderr.length < 8_000) stderr += chunk;
        });
        child.once("error", (error) => reject(new Error(`无法启动本地强制对齐程序：${error.message}`, { cause: error })));
        child.once("close", (code) => {
            if (code === 0) resolve(stdout);
            else {
                const diagnostic = stderr.trim() || stdout.trim() || "未返回诊断信息";
                reject(new Error(`本地强制对齐程序失败（退出码 ${code ?? "unknown"}）：${diagnostic}`));
            }
        });
    });
}
