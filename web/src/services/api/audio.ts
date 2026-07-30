import axios from "axios";

import { audioMimeType, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";

type RequestOptions = { signal?: AbortSignal };
type MiniMaxBaseResp = { status_code?: number; status_msg?: string };
type MiniMaxAudioResponse = {
    data?: { audio?: string; status?: number };
    extra_info?: { audio_format?: string; audio_sample_rate?: number };
    base_resp?: MiniMaxBaseResp;
    trace_id?: string;
};

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
    };
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<Blob> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.audioModel);
    const model = requestConfig.model.trim();
    const format = normalizeAudioFormatValue(config.audioFormat);
    const script = resolveModelScript(config, config.model || config.audioModel);
    if (script) {
        if (!model) throw new Error("请先配置音频模型");
        if (!requestConfig.baseUrl.trim()) throw new Error("请先配置 Base URL");
        if (!requestConfig.apiKey.trim()) throw new Error("请先配置 API Key");
        try {
            const result = await runModelPlugin({
                capability: "audio",
                script,
                config: requestConfig,
                prompt,
                params: { voice: normalizeAudioVoiceValue(config.audioVoice), format, speed: normalizeAudioSpeedValue(config.audioSpeed), instructions: config.audioInstructions.trim() },
                signal: options?.signal,
            });
            return await audioPluginBlob(result, format);
        } catch (error) {
            throw new Error(readAxiosError(error, "音频生成失败"));
        }
    }
    assertAudioConfig(requestConfig, model);
    const instructions = config.audioInstructions.trim();

    try {
        if (requestConfig.apiFormat === "minimax") return await requestMiniMaxAudio(requestConfig, prompt, format, options);
        const response = await axios.post<Blob>(
            aiApiUrl(requestConfig, "/audio/speech"),
            {
                model,
                input: prompt,
                voice: normalizeAudioVoiceValue(config.audioVoice),
                response_format: format,
                speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
                ...(instructions ? { instructions } : {}),
            },
            { headers: aiHeaders(requestConfig), responseType: "blob", signal: options?.signal },
        );
        await assertAudioBlob(response.data);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, "音频生成失败"));
    }
}

async function requestMiniMaxAudio(config: AiConfig, prompt: string, format: string, options?: RequestOptions) {
    const minimaxFormat = normalizeMiniMaxAudioFormat(format);
    const response = await axios.post<MiniMaxAudioResponse>(
        aiApiUrl(config, "/t2a_v2"),
        {
            model: config.model.trim() || "speech-2.8-hd",
            text: prompt.slice(0, 10000),
            stream: false,
            output_format: "hex",
            voice_setting: {
                voice_id: normalizeMiniMaxVoice(config.audioVoice),
                speed: normalizeMiniMaxSpeed(config.audioSpeed),
                vol: 1,
                pitch: 0,
            },
            audio_setting: {
                sample_rate: 32000,
                bitrate: 128000,
                format: minimaxFormat,
                channel: 1,
            },
            subtitle_enable: false,
            aigc_watermark: false,
        },
        { headers: aiHeaders(config), signal: options?.signal },
    );
    validateMiniMaxBaseResp(response.data.base_resp);
    const audioHex = response.data.data?.audio;
    if (!audioHex) throw new Error("MiniMax 音频接口没有返回音频数据");
    return new Blob([hexToBytes(audioHex)], { type: audioMimeType(minimaxFormat) });
}

async function audioPluginBlob(result: unknown, format: string): Promise<Blob> {
    if (result instanceof Blob) return result.type.startsWith("audio/") ? result : new Blob([result], { type: audioMimeType(format) });
    let source = "";
    if (typeof result === "string") source = result;
    else if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        source = typeof record.b64_json === "string" ? record.b64_json : typeof record.data === "string" ? record.data : typeof record.url === "string" ? record.url : "";
    }
    if (!source) throw new Error("模型调用脚本没有返回音频");
    const url = source.startsWith("data:") || /^https?:/i.test(source) ? source : `data:${audioMimeType(format)};base64,${source}`;
    const blob = await (await fetch(url)).blob();
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置音频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持音频生成，请使用 OpenAI 格式渠道");
}

function normalizeMiniMaxAudioFormat(format: string) {
    return ["mp3", "wav", "opus", "flac", "pcm"].includes(format) ? format : "mp3";
}

function normalizeMiniMaxVoice(voice: string) {
    const value = voice.trim();
    if (value && !["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"].includes(value)) return value;
    return "male-qn-qingse";
}

function normalizeMiniMaxSpeed(value: string) {
    const speed = Number(normalizeAudioSpeedValue(value));
    return Math.max(0.5, Math.min(2, Number(speed.toFixed(2))));
}

function validateMiniMaxBaseResp(baseResp: MiniMaxBaseResp | undefined) {
    if (baseResp?.status_code && baseResp.status_code !== 0) throw new Error(baseResp.status_msg || `MiniMax 请求失败：${baseResp.status_code}`);
}

function hexToBytes(hex: string) {
    const clean = hex.trim();
    const bytes = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return `服务返回了 HTML 错误页面（${value.slice(0, 80)}...）`;
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown; base_resp?: MiniMaxBaseResp };
    const errorMsg = typeof payload.error === "string" ? payload.error : (payload.error as { message?: unknown })?.message;
    return readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.message) || readApiErrorMessage(errorMsg) || readApiErrorMessage(payload.detail) || readApiErrorMessage(payload.base_resp?.status_msg) || "";
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        const statusMsg = statusMessage(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    if (status === 404) return "接口地址不存在（404），请检查 Base URL 和模型选择";
    if (status === 502) return "网关错误（502），接口服务暂时不可用，请稍后重试";
    if (status === 503) return "服务繁忙（503），请稍后重试";
    return status ? `请求失败（HTTP ${status}），请检查 Base URL 和 API Key 是否正确` : fallback;
}
