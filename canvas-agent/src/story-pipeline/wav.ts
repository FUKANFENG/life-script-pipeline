import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ensureDirectory, replaceFile } from "./io.js";

export type WavInfo = {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    blockAlign: number;
    dataBytes: number;
    sampleCount: number;
    durationSeconds: number;
};

export type NormalizeAudioOptions = {
    ffmpegPath?: string;
    sampleRate?: number;
    channels?: number;
    pcmCodec?: "pcm_s16le" | "pcm_s24le";
};

/** 读取 WAV 容器的 fmt/data 块，以最终 PCM 数据推导真实采样数。 */
export function readWavInfo(filePath: string): WavInfo {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error(`不是有效的 RIFF/WAVE 文件：${filePath}`);
    }

    let offset = 12;
    let format: Omit<WavInfo, "dataBytes" | "sampleCount" | "durationSeconds"> | undefined;
    let dataBytes: number | undefined;
    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString("ascii", offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const contentOffset = offset + 8;
        if (contentOffset + chunkSize > buffer.length) throw new Error(`WAV 块长度越界：${chunkId}`);

        if (chunkId === "fmt ") {
            if (chunkSize < 16) throw new Error("WAV fmt 块长度不足");
            format = {
                audioFormat: buffer.readUInt16LE(contentOffset),
                channels: buffer.readUInt16LE(contentOffset + 2),
                sampleRate: buffer.readUInt32LE(contentOffset + 4),
                blockAlign: buffer.readUInt16LE(contentOffset + 12),
                bitsPerSample: buffer.readUInt16LE(contentOffset + 14),
            };
        } else if (chunkId === "data") {
            dataBytes = chunkSize;
        }
        offset = contentOffset + chunkSize + (chunkSize % 2);
    }

    if (!format) throw new Error("WAV 缺少 fmt 块");
    if (dataBytes === undefined) throw new Error("WAV 缺少 data 块");
    if (format.blockAlign <= 0 || dataBytes % format.blockAlign !== 0) {
        throw new Error("WAV PCM 数据未按 blockAlign 对齐");
    }
    const sampleCount = dataBytes / format.blockAlign;
    return {
        ...format,
        dataBytes,
        sampleCount,
        durationSeconds: sampleCount / format.sampleRate,
    };
}

/** 使用 FFmpeg 归一化为 48 kHz 单声道 PCM WAV，并重新读取采样数。 */
export async function normalizeWav(
    sourcePath: string,
    destinationPath: string,
    options: NormalizeAudioOptions = {},
): Promise<WavInfo> {
    const sampleRate = options.sampleRate ?? 48_000;
    const channels = options.channels ?? 1;
    const codec = options.pcmCodec ?? "pcm_s16le";
    const executable = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    ensureDirectory(path.dirname(destinationPath));
    const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp.wav`;
    try {
        await runProcess(executable, [
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-i", sourcePath,
            "-vn",
            "-ac", String(channels),
            "-ar", String(sampleRate),
            "-c:a", codec,
            temporaryPath,
        ]);
        const info = readWavInfo(temporaryPath);
        if (info.sampleRate !== sampleRate || info.channels !== channels || ![1, 65_534].includes(info.audioFormat)) {
            throw new Error(`归一化结果不符合要求：${info.sampleRate} Hz / ${info.channels} ch / format ${info.audioFormat}`);
        }
        replaceFile(temporaryPath, destinationPath);
        return info;
    } finally {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
    }
}

function runProcess(executable: string, args: string[]) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
        let errorOutput = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            if (errorOutput.length < 8_000) errorOutput += chunk;
        });
        child.once("error", (error) => {
            reject(new Error(`无法启动 FFmpeg，请设置 FFMPEG_PATH：${error.message}`, { cause: error }));
        });
        child.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg 归一化失败（退出码 ${code ?? "unknown"}）：${errorOutput.trim()}`));
        });
    });
}
