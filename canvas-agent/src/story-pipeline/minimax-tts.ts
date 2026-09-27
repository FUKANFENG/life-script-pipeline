import fs from "node:fs";
import path from "node:path";

import {
    canonicalJsonSha256,
    normalizeTtsText,
    sha256File,
    TTS_TEXT_NORMALIZER_VERSION,
} from "./canonical.js";
import { ensureDirectory, readJsonFile, writeFileAtomic, writeJsonAtomic } from "./io.js";
import type { NarrationSegmentSchema, VoiceProfile } from "./schemas.js";
import { redactSecrets, safeErrorDetails } from "./security.js";
import { normalizeWav, readWavInfo, type NormalizeAudioOptions, type WavInfo } from "./wav.js";
import type { z } from "zod";

export const MINIMAX_TTS_ADAPTER_SCHEMA = "minimax-t2a-adapter/1";

type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;

export type TtsBuildMode = "draft" | "final";
export type FailureClassification = "safe_to_retry" | "unknown_outcome" | "permanent_failure";

export type CanonicalTtsRequest = {
    adapter_schema: typeof MINIMAX_TTS_ADAPTER_SCHEMA;
    provider: "minimax";
    api: "t2a_v2";
    model: string;
    text_normalized: string;
    text_normalization_version: typeof TTS_TEXT_NORMALIZER_VERSION;
    voice_setting: {
        voice_id: string;
        speed: number;
        vol: number;
        pitch: number;
        emotion: string | null;
    };
    pronunciation_dict: {
        tone: string[];
    };
    language_boost: string;
    subtitle: {
        enabled: true;
        type: "word";
    };
    audio_setting: {
        sample_rate: 44_100;
        format: "wav";
        channel: 1;
    };
};

export type TtsArtifact = {
    segmentId: string;
    requestHash: string;
    providerAudioHash: string;
    normalizedAudioHash: string;
    sourceAudioPath: string;
    normalizedAudioPath: string;
    providerTimestampsPath: string;
    durationSamples: number;
    cacheHit: boolean;
};

export type MiniMaxTtsAdapterOptions = {
    cacheDirectory: string;
    apiKey?: string;
    apiHost?: string;
    rpm?: number;
    maxConcurrency?: number;
    maxAttempts?: number;
    requestTimeoutMs?: number;
    ffmpegPath?: string;
    fetchImpl?: typeof fetch;
    normalizeAudio?: (
        sourcePath: string,
        destinationPath: string,
        options: NormalizeAudioOptions,
    ) => Promise<WavInfo>;
};

type CachePaths = ReturnType<typeof getCachePaths>;

export class MiniMaxTtsAdapter {
    private readonly options: Required<Pick<
        MiniMaxTtsAdapterOptions,
        "cacheDirectory" | "apiHost" | "rpm" | "maxConcurrency" | "maxAttempts" | "requestTimeoutMs"
    >> & MiniMaxTtsAdapterOptions;
    private readonly limiter: RequestLimiter;
    private readonly fetchImpl: typeof fetch;

    constructor(options: MiniMaxTtsAdapterOptions) {
        this.options = {
            ...options,
            cacheDirectory: options.cacheDirectory,
            apiHost: (options.apiHost || process.env.MINIMAX_API_HOST || "https://api.minimaxi.com").replace(/\/+$/, ""),
            rpm: positiveInteger(options.rpm ?? numberFromEnvironment("MINIMAX_TTS_RPM", 10), "rpm"),
            maxConcurrency: positiveInteger(
                options.maxConcurrency ?? numberFromEnvironment("MINIMAX_TTS_MAX_CONCURRENCY", 2),
                "maxConcurrency",
            ),
            maxAttempts: positiveInteger(options.maxAttempts ?? 3, "maxAttempts"),
            requestTimeoutMs: positiveInteger(options.requestTimeoutMs ?? 120_000, "requestTimeoutMs"),
        };
        this.fetchImpl = options.fetchImpl || fetch;
        this.limiter = new RequestLimiter(this.options.rpm, this.options.maxConcurrency);
    }

    async synthesize(input: {
        segment: NarrationSegment;
        profile: VoiceProfile;
        pronunciationTone?: string[];
        mode: TtsBuildMode;
        force?: boolean;
    }): Promise<TtsArtifact> {
        const request = buildCanonicalTtsRequest(input);
        const requestHash = canonicalJsonSha256(request);
        const paths = getCachePaths(this.options.cacheDirectory, requestHash);
        ensureDirectory(paths.directory);

        if (input.force) archiveCurrentAttempt(paths);
        const cached = readCompleteArtifact(input.segment.id, requestHash, paths);
        if (cached) return { ...cached, cacheHit: true };

        let stage = "prepare_request";
        writeJsonAtomic(paths.request, request);
        try {
            let providerResponse: unknown = fs.existsSync(paths.response)
                ? readJsonFile<unknown>(paths.response)
                : undefined;
            let providerTimestamps: unknown = fs.existsSync(paths.providerTimestamps)
                ? readJsonFile<unknown>(paths.providerTimestamps)
                : undefined;
            let providerHttp: unknown = fs.existsSync(paths.httpMetadata)
                ? readJsonFile<unknown>(paths.httpMetadata)
                : undefined;

            if (!fs.existsSync(paths.sourceAudio)) {
                stage = "request_provider";
                const fresh = await this.requestProvider(request);
                providerResponse = fresh.response;
                providerHttp = fresh.httpMetadata;

                stage = "download_audio";
                await this.persistAudioPayload(fresh.audioPayload, paths.sourceAudio);

                stage = "download_timestamps";
                providerTimestamps = await this.readTimestampPayload(fresh.subtitlePayload);
                writeJsonAtomic(paths.providerTimestamps, providerTimestamps ?? { words: [] });
                writeJsonAtomic(paths.response, sanitizeProviderResponse(providerResponse));
                writeJsonAtomic(paths.httpMetadata, providerHttp);
            }

            if (!fs.existsSync(paths.providerTimestamps)) {
                writeJsonAtomic(paths.providerTimestamps, providerTimestamps ?? { words: [] });
            }

            stage = "normalize_audio";
            const normalizedInfo = fs.existsSync(paths.normalizedAudio)
                ? readWavInfo(paths.normalizedAudio)
                : await (this.options.normalizeAudio || normalizeWav)(
                    paths.sourceAudio,
                    paths.normalizedAudio,
                    { ffmpegPath: this.options.ffmpegPath, sampleRate: 48_000, channels: 1, pcmCodec: "pcm_s16le" },
                );
            if (normalizedInfo.sampleRate !== 48_000 || normalizedInfo.channels !== 1) {
                throw new Error("归一化 WAV 必须是 48 kHz 单声道");
            }

            stage = "write_receipt";
            const sourceInfo = readWavInfo(paths.sourceAudio);
            const providerAudioHash = sha256File(paths.sourceAudio);
            const normalizedAudioHash = sha256File(paths.normalizedAudio);
            const receipt = {
                schema_version: "1.0",
                status: "complete",
                provider: "minimax",
                adapter_schema: MINIMAX_TTS_ADAPTER_SCHEMA,
                request_hash: requestHash,
                provider_audio_hash: providerAudioHash,
                normalized_audio_hash: normalizedAudioHash,
                source_audio: {
                    sample_rate: sourceInfo.sampleRate,
                    channels: sourceInfo.channels,
                    sample_count: sourceInfo.sampleCount,
                },
                normalized_audio: {
                    sample_rate: normalizedInfo.sampleRate,
                    channels: normalizedInfo.channels,
                    sample_count: normalizedInfo.sampleCount,
                },
                trace_id: extractTraceId(providerResponse),
                provider_http: providerHttp,
                completed_at: new Date().toISOString(),
            };
            writeJsonAtomic(paths.receipt, redactSecrets(receipt));
            return {
                segmentId: input.segment.id,
                requestHash,
                providerAudioHash,
                normalizedAudioHash,
                sourceAudioPath: paths.sourceAudio,
                normalizedAudioPath: paths.normalizedAudio,
                providerTimestampsPath: paths.providerTimestamps,
                durationSamples: normalizedInfo.sampleCount,
                cacheHit: false,
            };
        } catch (error) {
            const classification = error instanceof TtsAdapterError ? error.classification : "permanent_failure";
            writeJsonAtomic(paths.receipt, {
                schema_version: "1.0",
                status: "failed",
                provider: "minimax",
                adapter_schema: MINIMAX_TTS_ADAPTER_SCHEMA,
                request_hash: requestHash,
                stage,
                failure_classification: classification,
                error: safeErrorDetails(error),
                failed_at: new Date().toISOString(),
            });
            throw error;
        }
    }

    private async requestProvider(request: CanonicalTtsRequest) {
        const apiKey = this.options.apiKey || process.env.MINIMAX_API_KEY;
        if (!apiKey) {
            throw new TtsAdapterError("未配置 MINIMAX_API_KEY", "permanent_failure");
        }
        const body = {
            model: request.model,
            text: request.text_normalized,
            stream: false,
            voice_setting: withoutNullValues(request.voice_setting),
            pronunciation_dict: request.pronunciation_dict.tone.length ? request.pronunciation_dict : undefined,
            language_boost: request.language_boost,
            subtitle_enable: true,
            subtitle_type: "word",
            output_format: "url",
            audio_setting: request.audio_setting,
        };

        let lastError: unknown;
        for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
            try {
                return await this.limiter.run(async () => {
                    const requestStartedAt = Date.now();
                    const { response, body: responseText } = await fetchWithTimeout(
                        this.fetchImpl,
                        `${this.options.apiHost}/v1/t2a_v2`,
                        {
                            method: "POST",
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify(body),
                        },
                        this.options.requestTimeoutMs,
                        true,
                        (current) => current.text(),
                    );
                    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
                    const responseBody = parseResponseJson(responseText);
                    if (!response.ok) {
                        throw responseError(response.status, responseBody, retryAfterMs);
                    }
                    const providerCode = getProviderStatusCode(responseBody);
                    if (providerCode !== undefined && providerCode !== 0) {
                        throw new TtsAdapterError(
                            `MiniMax 返回错误码 ${providerCode}：${getProviderMessage(responseBody) || "未知错误"}`,
                            isRecoverableProviderCode(providerCode) ? "safe_to_retry" : "permanent_failure",
                            retryAfterMs,
                        );
                    }
                    const audioPayload = getNestedField(responseBody, ["data", "audio"]);
                    if (typeof audioPayload !== "string" || !audioPayload) {
                        throw new TtsAdapterError("MiniMax 响应缺少 data.audio", "permanent_failure");
                    }
                    return {
                        response: responseBody,
                        audioPayload,
                        subtitlePayload: getNestedField(responseBody, ["data", "subtitle_file"]),
                        httpMetadata: {
                            status: response.status,
                            duration_ms: Date.now() - requestStartedAt,
                            headers: selectDiagnosticHeaders(response.headers),
                        },
                    };
                });
            } catch (error) {
                lastError = classifyNetworkError(error);
                if (!(lastError instanceof TtsAdapterError)
                    || lastError.classification !== "safe_to_retry"
                    || attempt >= this.options.maxAttempts) {
                    throw lastError;
                }
                await delay(lastError.retryAfterMs ?? exponentialBackoff(attempt));
            }
        }
        throw lastError;
    }

    private async persistAudioPayload(payload: string, destinationPath: string) {
        if (/^https?:\/\//i.test(payload)) {
            const audio = await downloadWithRetry(
                this.fetchImpl,
                payload,
                this.options.requestTimeoutMs,
                this.options.maxAttempts,
                (response) => response.arrayBuffer(),
            );
            writeFileAtomic(destinationPath, new Uint8Array(audio));
            return;
        }
        if (payload.startsWith("data:")) {
            const comma = payload.indexOf(",");
            if (comma < 0) throw new TtsAdapterError("MiniMax 内联音频 Data URL 无效", "permanent_failure");
            writeFileAtomic(destinationPath, Buffer.from(payload.slice(comma + 1), "base64"));
            return;
        }
        const compact = payload.replace(/\s/g, "");
        if (/^[a-f0-9]+$/i.test(compact) && compact.length % 2 === 0) {
            writeFileAtomic(destinationPath, Buffer.from(compact, "hex"));
            return;
        }
        if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
            writeFileAtomic(destinationPath, Buffer.from(compact, "base64"));
            return;
        }
        throw new TtsAdapterError("无法识别 MiniMax 音频载荷格式", "permanent_failure");
    }

    private async readTimestampPayload(payload: unknown) {
        if (typeof payload === "string" && /^https?:\/\//i.test(payload)) {
            const text = await downloadWithRetry(
                this.fetchImpl,
                payload,
                this.options.requestTimeoutMs,
                this.options.maxAttempts,
                (response) => response.text(),
            );
            try {
                return JSON.parse(text) as unknown;
            } catch {
                return { raw: text };
            }
        }
        return payload ?? { words: [] };
    }
}

export function buildCanonicalTtsRequest(input: {
    segment: NarrationSegment;
    profile: VoiceProfile;
    pronunciationTone?: string[];
    mode: TtsBuildMode;
}): CanonicalTtsRequest {
    const localEmotion = input.segment.delivery.emotion;
    return {
        adapter_schema: MINIMAX_TTS_ADAPTER_SCHEMA,
        provider: "minimax",
        api: "t2a_v2",
        model: input.mode === "draft" ? input.profile.draft_model : input.profile.final_model,
        text_normalized: normalizeTtsText(input.segment.text),
        text_normalization_version: TTS_TEXT_NORMALIZER_VERSION,
        voice_setting: {
            voice_id: input.profile.voice_id,
            speed: input.profile.speed,
            vol: input.profile.vol,
            pitch: input.profile.pitch,
            emotion: localEmotion === undefined ? input.profile.emotion : localEmotion,
        },
        pronunciation_dict: {
            tone: [...(input.pronunciationTone || [])].sort((first, second) => first.localeCompare(second, "zh-CN")),
        },
        language_boost: input.profile.language_boost,
        subtitle: { enabled: true, type: "word" },
        audio_setting: { sample_rate: 44_100, format: "wav", channel: 1 },
    };
}

function getCachePaths(cacheDirectory: string, requestHash: string) {
    const directory = path.join(cacheDirectory, requestHash);
    return {
        directory,
        request: path.join(directory, "request.json"),
        response: path.join(directory, "response.json"),
        httpMetadata: path.join(directory, "http_metadata.json"),
        sourceAudio: path.join(directory, "source_44100.wav"),
        normalizedAudio: path.join(directory, "normalized_48000_mono.wav"),
        providerTimestamps: path.join(directory, "timestamps.provider.json"),
        receipt: path.join(directory, "receipt.json"),
        history: path.join(directory, "history"),
    };
}

function readCompleteArtifact(segmentId: string, requestHash: string, paths: CachePaths): Omit<TtsArtifact, "cacheHit"> | undefined {
    if (!fs.existsSync(paths.receipt)) return undefined;
    try {
        const receipt = readJsonFile<Record<string, unknown>>(paths.receipt);
        if (receipt.status !== "complete" || receipt.request_hash !== requestHash) return undefined;
        if (!fs.existsSync(paths.sourceAudio) || !fs.existsSync(paths.normalizedAudio) || !fs.existsSync(paths.providerTimestamps)) {
            return undefined;
        }
        const providerAudioHash = String(receipt.provider_audio_hash || "");
        const normalizedAudioHash = String(receipt.normalized_audio_hash || "");
        if (sha256File(paths.sourceAudio) !== providerAudioHash || sha256File(paths.normalizedAudio) !== normalizedAudioHash) {
            return undefined;
        }
        return {
            segmentId,
            requestHash,
            providerAudioHash,
            normalizedAudioHash,
            sourceAudioPath: paths.sourceAudio,
            normalizedAudioPath: paths.normalizedAudio,
            providerTimestampsPath: paths.providerTimestamps,
            durationSamples: readWavInfo(paths.normalizedAudio).sampleCount,
        };
    } catch {
        return undefined;
    }
}

function archiveCurrentAttempt(paths: CachePaths) {
    const files = [
        paths.request,
        paths.response,
        paths.httpMetadata,
        paths.sourceAudio,
        paths.normalizedAudio,
        paths.providerTimestamps,
        paths.receipt,
    ].filter((filePath) => fs.existsSync(filePath));
    if (files.length === 0) return;
    let hashSuffix = "incomplete";
    try {
        hashSuffix = sha256File(paths.normalizedAudio).slice(0, 12);
    } catch {
        // 未完成构建没有归一化音频时保留 incomplete 标记。
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(paths.history, `${timestamp}-${hashSuffix}`);
    ensureDirectory(destination);
    for (const filePath of files) {
        fs.renameSync(filePath, path.join(destination, path.basename(filePath)));
    }
}

class TtsAdapterError extends Error {
    constructor(
        message: string,
        readonly classification: FailureClassification,
        readonly retryAfterMs?: number,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "TtsAdapterError";
    }
}

class RequestLimiter {
    private readonly bucket: TokenBucket;
    private readonly semaphore: Semaphore;

    constructor(rpm: number, concurrency: number) {
        this.bucket = new TokenBucket(rpm);
        this.semaphore = new Semaphore(concurrency);
    }

    run<T>(operation: () => Promise<T>) {
        return this.semaphore.run(async () => {
            await this.bucket.take();
            return operation();
        });
    }
}

class TokenBucket {
    private tokens: number;
    private lastRefill = Date.now();

    constructor(private readonly capacity: number) {
        this.tokens = capacity;
    }

    async take() {
        while (true) {
            this.refill();
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }
            const waitMs = Math.max(25, Math.ceil(60_000 / this.capacity));
            await delay(waitMs);
        }
    }

    private refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.capacity / 60_000);
        this.lastRefill = now;
    }
}

class Semaphore {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly maximum: number) {}

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.active >= this.maximum) await new Promise<void>((resolve) => this.waiters.push(resolve));
        this.active += 1;
        try {
            return await operation();
        } finally {
            this.active -= 1;
            this.waiters.shift()?.();
        }
    }
}

async function fetchWithTimeout<T>(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit,
    timeoutMs: number,
    billedRequest: boolean,
    readBody: (response: Response) => Promise<T>,
) {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error(`request timed out after ${timeoutMs} ms`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([
            (async () => {
                const response = await fetchImpl(url, { ...init, signal: controller.signal });
                const body = await readBody(response);
                return { response, body };
            })(),
            timeoutPromise,
        ]);
    } catch (error) {
        if (timedOut) {
            throw new TtsAdapterError(
                `请求读取超时（${timeoutMs} ms）`,
                billedRequest ? "unknown_outcome" : "safe_to_retry",
                undefined,
                { cause: error },
            );
        }
        throw classifyNetworkError(error, billedRequest);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function downloadWithRetry<T>(
    fetchImpl: typeof fetch,
    url: string,
    timeoutMs: number,
    maxAttempts: number,
    readBody: (response: Response) => Promise<T>,
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const { response, body } = await fetchWithTimeout(
                fetchImpl,
                url,
                { method: "GET" },
                timeoutMs,
                false,
                async (current) => {
                    if (!current.ok) return current.text() as Promise<T>;
                    return readBody(current);
                },
            );
            if (!response.ok) {
                throw responseError(response.status, body, parseRetryAfter(response.headers.get("retry-after")));
            }
            return body;
        } catch (error) {
            lastError = classifyNetworkError(error, false);
            if (!(lastError instanceof TtsAdapterError)
                || lastError.classification !== "safe_to_retry"
                || attempt >= maxAttempts) {
                throw lastError;
            }
            await delay(lastError.retryAfterMs ?? exponentialBackoff(attempt));
        }
    }
    throw lastError;
}

function classifyNetworkError(error: unknown, billedRequest = true): unknown {
    if (error instanceof TtsAdapterError) return error;
    const code = getErrorCode(error);
    const safeCodes = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
    return new TtsAdapterError(
        error instanceof Error ? error.message : String(error),
        safeCodes.has(code || "") || !billedRequest ? "safe_to_retry" : "unknown_outcome",
        undefined,
        { cause: error },
    );
}

function responseError(status: number, responseBody: unknown, retryAfterMs?: number) {
    const recoverable = status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    return new TtsAdapterError(
        `MiniMax HTTP ${status}：${safeResponseSummary(responseBody)}`,
        recoverable ? "safe_to_retry" : "permanent_failure",
        retryAfterMs,
    );
}

function parseResponseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new TtsAdapterError(`MiniMax 返回了非 JSON 响应：${safeResponseSummary(value)}`, "permanent_failure");
    }
}

function sanitizeProviderResponse(value: unknown) {
    const sanitized = structuredClone(value) as unknown;
    if (sanitized && typeof sanitized === "object") {
        const data = (sanitized as Record<string, unknown>).data;
        if (data && typeof data === "object") {
            const record = data as Record<string, unknown>;
            if ("audio" in record) record.audio = "[AUDIO_DOWNLOADED]";
            if ("subtitle_file" in record) record.subtitle_file = "[SUBTITLE_DOWNLOADED]";
        }
    }
    return redactSecrets(sanitized);
}

function safeResponseSummary(value: unknown) {
    const serialized = typeof value === "string" ? value : JSON.stringify(redactSecrets(value));
    return serialized.slice(0, 500);
}

function getProviderStatusCode(value: unknown) {
    const code = getNestedField(value, ["base_resp", "status_code"]);
    return typeof code === "number" ? code : typeof code === "string" && code ? Number(code) : undefined;
}

function getProviderMessage(value: unknown) {
    const message = getNestedField(value, ["base_resp", "status_msg"]);
    return typeof message === "string" ? message : undefined;
}

function extractTraceId(value: unknown) {
    const traceId = getNestedField(value, ["trace_id"]);
    return typeof traceId === "string" ? traceId : undefined;
}

function getNestedField(value: unknown, pathParts: string[]): unknown {
    let current = value;
    for (const part of pathParts) {
        if (!current || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function withoutNullValues(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, current]) => current !== null && current !== undefined));
}

function getErrorCode(error: unknown) {
    if (!error || typeof error !== "object") return undefined;
    const direct = (error as { code?: unknown }).code;
    if (typeof direct === "string") return direct;
    const cause = (error as { cause?: unknown }).cause;
    return cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
        ? (cause as { code: string }).code
        : undefined;
}

function parseRetryAfter(value: string | null) {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function selectDiagnosticHeaders(headers: Headers) {
    const output: Record<string, string> = {};
    headers.forEach((value, name) => {
        const normalized = name.toLowerCase();
        if (normalized === "retry-after"
            || normalized.includes("ratelimit")
            || normalized.includes("rate-limit")
            || normalized === "x-request-id"
            || normalized === "request-id") {
            output[normalized] = value;
        }
    });
    return output;
}

function exponentialBackoff(attempt: number) {
    const base = Math.min(30_000, 750 * 2 ** Math.max(0, attempt - 1));
    return Math.round(base * (0.75 + Math.random() * 0.5));
}

function isRecoverableProviderCode(code: number) {
    return [1002, 1004, 1008, 1027, 1039, 2013].includes(code);
}

function positiveInteger(value: number, name: string) {
    if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} 必须是正整数`);
    return value;
}

function numberFromEnvironment(name: string, fallback: number) {
    const value = process.env[name];
    return value && Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function delay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
