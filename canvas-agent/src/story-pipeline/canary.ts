import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
    CommandForcedAligner,
    normalizeProviderTimestamps,
    resolveAlignment,
    type ForcedAligner,
    type ShadowAsrProbe,
    type ShadowAsrResult,
} from "./alignment.js";
import { sha256File } from "./canonical.js";
import { ensureDirectory, readJsonFile, writeJsonAtomic } from "./io.js";
import { runStoryPipeline, type StoryPipelineOptions, type StoryTtsSynthesizer } from "./pipeline.js";
import { StoryManifestSchema, type StoryManifest } from "./schemas.js";
import { redactSecrets } from "./security.js";
import { AUDIO_SAMPLE_RATE, samplesToFrames } from "./timebase.js";
import { tokenizeNarration } from "./tokenization.js";
import { readWavInfo } from "./wav.js";

export const MINIMAX_CANARY_SCHEMA = "minimax-production-canary/1";

export type CanaryPreflightCheck = {
    id: string;
    passed: boolean;
    detail: string;
};

export type CanaryPreflightReport = {
    schema_version: typeof MINIMAX_CANARY_SCHEMA;
    ready: boolean;
    checks: CanaryPreflightCheck[];
    estimated_duration_seconds: number;
};

export type MiniMaxCanaryOptions = {
    manifestPath: string;
    projectDirectory: string;
    ffmpegPath?: string;
    alignerExecutable?: string;
    forcedAligner?: ForcedAligner;
    shadowAsrProbe?: ShadowAsrProbe;
    synthesizer?: StoryTtsSynthesizer;
    apiKey?: string;
    skipEnvironmentPreflight?: boolean;
    fixtureRootDirectory?: string;
    now?: () => Date;
};

export type MiniMaxProductionCanaryOptions = Omit<
    MiniMaxCanaryOptions,
    "manifestPath" | "projectDirectory" | "synthesizer" | "fixtureRootDirectory"
> & {
    smokeManifestPath: string;
    hdManifestPath: string;
    projectDirectory: string;
    smokeSynthesizer?: StoryTtsSynthesizer;
    hdSynthesizer?: StoryTtsSynthesizer;
};

export type ProductionCanaryPreflightReport = {
    schema_version: typeof MINIMAX_CANARY_SCHEMA;
    ready: boolean;
    smoke: CanaryPreflightReport;
    hd: CanaryPreflightReport;
};

type CanaryCheck = {
    id: string;
    passed: boolean;
    required: boolean;
    detail: string;
};

/** 在任何计费请求之前检查凭据、Voice ID、本地依赖与夹具风险覆盖。 */
export function inspectCanaryPreflight(options: MiniMaxCanaryOptions): CanaryPreflightReport {
    const manifest = StoryManifestSchema.parse(readJsonFile<unknown>(path.resolve(options.manifestPath)));
    const apiKey = options.apiKey || process.env.MINIMAX_API_KEY;
    const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "";
    const alignerExecutable = options.alignerExecutable || process.env.STORY_ALIGNER_EXECUTABLE || "";
    const text = manifest.narration_segments.map((segment) => segment.text).join("\n");
    const voiceReady = Object.values(manifest.voice_profiles).every((profile) => !isPlaceholder(profile.voice_id));
    const alignerInspection = inspectAligner(
        alignerExecutable,
        ffmpegPath,
        Boolean(options.forcedAligner),
    );
    const estimatedDuration = manifest.narration_segments
        .map((segment) => tokenizeNarration(segment.text).length / 4)
        .reduce((sum, current) => sum + current, 0);
    const checks: CanaryPreflightCheck[] = [
        {
            id: "dedicated_api_key",
            passed: Boolean(apiKey && /^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey)),
            detail: apiKey ? "已从运行时注入 Key，未读取或输出明文" : "缺少 MINIMAX_API_KEY",
        },
        {
            id: "real_voice_id",
            passed: voiceReady,
            detail: voiceReady
                ? "所有 Voice Profile 均使用非占位 voice_id"
                : "Manifest 仍包含占位 voice_id",
        },
        {
            id: "ffmpeg",
            passed: executableExists(ffmpegPath),
            detail: ffmpegPath ? "FFmpeg 路径已配置" : "缺少 FFMPEG_PATH 或 --ffmpeg",
        },
        {
            id: "forced_aligner",
            passed: alignerInspection.ready,
            detail: alignerInspection.detail,
        },
        {
            id: "risk_text_duration",
            passed: estimatedDuration >= 20 && estimatedDuration <= 45,
            detail: `按稳定词元估算约 ${estimatedDuration.toFixed(1)} 秒`,
        },
        {
            id: "hd_model",
            passed: Object.values(manifest.voice_profiles)
                .every((profile) => profile.final_model === "speech-2.8-hd"),
            detail: "正式 Canary 必须使用 speech-2.8-hd",
        },
        {
            id: "risk_text_controls",
            passed: /<#0\.5#>/.test(text)
                && /\((?:breath|sighs)\)/i.test(text)
                && /[A-Za-z]/.test(text)
                && /\d/.test(text),
            detail: "夹具应同时包含停顿、语气标签、英文与数字",
        },
        {
            id: "risk_timeline_shape",
            passed: manifest.narration_segments.length === 2
                && manifest.shots.length >= 4
                && manifest.shots.length <= 6
                && manifest.shots.some((shot) => shot.narration_refs.length > 1)
                && manifest.shots.some((shot) => shot.transition_out.type === "dissolve"
                    && shot.transition_out.duration_frames === 15),
            detail: "夹具应有 2 段旁白、4–6 镜头、跨段镜头和 15 帧叠化",
        },
    ];
    return {
        schema_version: MINIMAX_CANARY_SCHEMA,
        ready: checks.every((check) => check.passed),
        checks,
        estimated_duration_seconds: estimatedDuration,
    };
}

export function inspectTurboSmokePreflight(options: MiniMaxCanaryOptions): CanaryPreflightReport {
    const manifest = StoryManifestSchema.parse(readJsonFile<unknown>(path.resolve(options.manifestPath)));
    const full = inspectCanaryPreflight(options);
    const estimatedDuration = manifest.narration_segments
        .map((segment) => tokenizeNarration(segment.text).length / 4)
        .reduce((sum, current) => sum + current, 0);
    const checks = full.checks.filter((check) =>
        !["risk_text_duration", "risk_text_controls", "risk_timeline_shape", "hd_model"].includes(check.id));
    checks.push(
        {
            id: "turbo_model",
            passed: Object.values(manifest.voice_profiles)
                .every((profile) => profile.draft_model === "speech-2.8-turbo"),
            detail: "烟雾测试必须使用 speech-2.8-turbo",
        },
        {
            id: "smoke_duration",
            passed: estimatedDuration >= 7 && estimatedDuration <= 13,
            detail: `按稳定词元估算约 ${estimatedDuration.toFixed(1)} 秒`,
        },
        {
            id: "smoke_shape",
            passed: manifest.narration_segments.length === 1 && manifest.shots.length === 1,
            detail: "烟雾夹具应只有 1 段旁白和 1 个镜头",
        },
    );
    return {
        schema_version: MINIMAX_CANARY_SCHEMA,
        ready: checks.every((check) => check.passed),
        checks,
        estimated_duration_seconds: estimatedDuration,
    };
}

export function inspectProductionCanaryPreflight(
    options: MiniMaxProductionCanaryOptions,
): ProductionCanaryPreflightReport {
    const shared = {
        projectDirectory: options.projectDirectory,
        ffmpegPath: options.ffmpegPath,
        alignerExecutable: options.alignerExecutable,
        forcedAligner: options.forcedAligner,
        apiKey: options.apiKey,
    };
    const smoke = inspectTurboSmokePreflight({
        ...shared,
        manifestPath: options.smokeManifestPath,
    });
    const hd = inspectCanaryPreflight({
        ...shared,
        manifestPath: options.hdManifestPath,
    });
    return {
        schema_version: MINIMAX_CANARY_SCHEMA,
        ready: smoke.ready && hd.ready,
        smoke,
        hd,
    };
}

export async function runMiniMaxProductionCanary(options: MiniMaxProductionCanaryOptions) {
    const preflight = inspectProductionCanaryPreflight(options);
    if (!options.skipEnvironmentPreflight && !preflight.ready) {
        const failures = [
            ...preflight.smoke.checks.filter((check) => !check.passed)
                .map((check) => `turbo.${check.id}: ${check.detail}`),
            ...preflight.hd.checks.filter((check) => !check.passed)
                .map((check) => `hd.${check.id}: ${check.detail}`),
        ];
        throw new Error(`MiniMax 生产金丝雀预检未通过：\n${failures.join("\n")}`);
    }

    const projectDirectory = path.resolve(options.projectDirectory);
    const smoke = await runTurboSmoke({
        manifestPath: options.smokeManifestPath,
        projectDirectory: path.join(projectDirectory, "turbo-smoke"),
        ffmpegPath: options.ffmpegPath,
        alignerExecutable: options.alignerExecutable,
        forcedAligner: options.forcedAligner,
        synthesizer: options.smokeSynthesizer,
        apiKey: options.apiKey,
        skipEnvironmentPreflight: true,
        now: options.now,
    });
    if (smoke.status !== "turbo_smoke_passed") {
        throw new Error("Turbo 烟雾测试未通过，已阻断 HD Canary");
    }

    const hd = await runMiniMaxCanary({
        manifestPath: options.hdManifestPath,
        projectDirectory: path.join(projectDirectory, "hd-canary"),
        ffmpegPath: options.ffmpegPath,
        alignerExecutable: options.alignerExecutable,
        forcedAligner: options.forcedAligner,
        shadowAsrProbe: options.shadowAsrProbe,
        synthesizer: options.hdSynthesizer,
        apiKey: options.apiKey,
        skipEnvironmentPreflight: true,
        fixtureRootDirectory: path.join(projectDirectory, "fixtures", "minimax-production-canary"),
        now: options.now,
    });
    const report = {
        schema_version: MINIMAX_CANARY_SCHEMA,
        status: hd.status,
        smoke_status: smoke.status,
        hd_status: hd.status,
        smoke_report: path.relative(projectDirectory, smoke.reportPath).replace(/\\/g, "/"),
        fixture_directory: path.relative(projectDirectory, hd.fixtureDirectory).replace(/\\/g, "/"),
        completed_at: (options.now || (() => new Date()))().toISOString(),
    };
    const reportPath = path.join(projectDirectory, "production-canary-report.json");
    writeJsonAtomic(reportPath, report);
    return {
        status: report.status,
        preflight,
        smoke,
        hd,
        report,
        reportPath,
    };
}

async function runTurboSmoke(options: MiniMaxCanaryOptions) {
    const preflight = inspectTurboSmokePreflight(options);
    if (!options.skipEnvironmentPreflight && !preflight.ready) {
        const failures = preflight.checks.filter((check) => !check.passed)
            .map((check) => `${check.id}: ${check.detail}`);
        throw new Error(`MiniMax Turbo 烟雾测试预检未通过：\n${failures.join("\n")}`);
    }
    const manifest = StoryManifestSchema.parse(readJsonFile<unknown>(path.resolve(options.manifestPath)));
    const result = await runStoryPipeline({
        manifestPath: options.manifestPath,
        projectDirectory: options.projectDirectory,
        mode: "draft",
        forceSegments: manifest.narration_segments.map((segment) => segment.id),
        ffmpegPath: options.ffmpegPath,
        alignerExecutable: options.alignerExecutable || process.env.STORY_ALIGNER_EXECUTABLE,
        forcedAligner: options.forcedAligner,
        synthesizer: options.synthesizer,
    });
    const checks = buildTurboSmokeChecks(result.artifacts);
    const now = (options.now || (() => new Date()))();
    const report = {
        schema_version: MINIMAX_CANARY_SCHEMA,
        status: checks.every((check) => check.passed) ? "turbo_smoke_passed" : "turbo_smoke_failed",
        project_id: manifest.project_id,
        checks,
        completed_at: now.toISOString(),
    };
    const reportPath = path.join(path.resolve(options.projectDirectory), "turbo-smoke-report.json");
    writeJsonAtomic(reportPath, report);
    return {
        status: report.status,
        report,
        reportPath,
        artifacts: result.artifacts,
    };
}

/** 执行一次真实金丝雀、一次缓存复跑、一次本地对齐影子探针，并保存脱敏 Golden Fixture。 */
export async function runMiniMaxCanary(options: MiniMaxCanaryOptions) {
    const preflight = inspectCanaryPreflight(options);
    if (!options.skipEnvironmentPreflight && !preflight.ready) {
        const failures = preflight.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`);
        throw new Error(`MiniMax 金丝雀预检未通过：\n${failures.join("\n")}`);
    }

    const manifest = StoryManifestSchema.parse(readJsonFile<unknown>(path.resolve(options.manifestPath)));
    const aligner = options.forcedAligner
        || (options.alignerExecutable || process.env.STORY_ALIGNER_EXECUTABLE
            ? new CommandForcedAligner(options.alignerExecutable || process.env.STORY_ALIGNER_EXECUTABLE!)
            : undefined);
    const shadowAsrProbe = options.shadowAsrProbe
        || (aligner && "shadowAsr" in aligner ? aligner as ForcedAligner & ShadowAsrProbe : undefined);
    const pipelineBase: StoryPipelineOptions = {
        manifestPath: options.manifestPath,
        projectDirectory: options.projectDirectory,
        mode: "final",
        ffmpegPath: options.ffmpegPath,
        alignerExecutable: options.alignerExecutable || process.env.STORY_ALIGNER_EXECUTABLE,
        forcedAligner: options.forcedAligner,
        synthesizer: options.synthesizer,
    };
    const first = await runStoryPipeline({
        ...pipelineBase,
        forceSegments: manifest.narration_segments.map((segment) => segment.id),
    });
    const firstTimelineHash = sha256File(first.timelinePath);
    const fallbackProbe = await runFallbackProbes(manifest, first.artifacts, aligner);
    const shadowAsr = await runShadowAsrProbes(manifest, first.artifacts, shadowAsrProbe);
    const second = await runStoryPipeline(pipelineBase);
    const secondTimelineHash = sha256File(second.timelinePath);

    const now = (options.now || (() => new Date()))();
    const fixtureDirectory = path.join(
        path.resolve(
            options.fixtureRootDirectory
                || path.join(options.projectDirectory, "fixtures", "minimax-production-canary"),
        ),
        `${formatTimestamp(now)}-${firstTimelineHash.slice(0, 12)}`,
    );
    ensureDirectory(fixtureDirectory);
    archiveCanaryArtifacts(
        fixtureDirectory,
        manifest,
        first.timeline,
        first.artifacts,
        fallbackProbe,
        shadowAsr,
    );
    writeJsonAtomic(path.join(fixtureDirectory, "preflight.json"), preflight);

    const checks = buildAcceptanceChecks({
        firstTimelineHash,
        secondTimelineHash,
        firstArtifacts: first.artifacts,
        secondArtifacts: second.artifacts,
        fallbackProbe,
        shadowAsr,
    });
    checks.push({
        id: "fixture_excludes_real_audio",
        passed: listFixtureFiles(fixtureDirectory)
            .every((filePath) => ![".wav", ".mp3", ".m4a", ".flac", ".aac", ".ogg"]
                .includes(path.extname(filePath).toLowerCase())),
        required: true,
        detail: "脱敏 Golden Fixture 不复制真实音频，仅保留哈希与音频事实",
    });
    const reportPath = path.join(fixtureDirectory, "acceptance-report.json");
    const report: {
        schema_version: typeof MINIMAX_CANARY_SCHEMA;
        status: string;
        project_id: string;
        model: string;
        first_timeline_sha256: string;
        second_timeline_sha256: string;
        checks: CanaryCheck[];
        limitations: string[];
        completed_at: string;
    } = {
        schema_version: MINIMAX_CANARY_SCHEMA,
        status: "production_acceptance_pending_security_scan",
        project_id: manifest.project_id,
        model: "speech-2.8-hd",
        first_timeline_sha256: firstTimelineHash,
        second_timeline_sha256: secondTimelineHash,
        checks,
        limitations: [
            "不主动制造真实 POST 超时；unknown_outcome 不重发由自动化故障注入测试覆盖",
            "临时下载 URL 在下载后立即脱敏，不保存可在 24 小时后复查的签名地址",
            "限流响应只在服务端自然返回 429 时记录，不通过突发请求主动触发",
        ],
        completed_at: now.toISOString(),
    };
    writeJsonAtomic(reportPath, report);
    const securityScan = scanFixtureFiles(
        listFixtureTextFiles(fixtureDirectory),
        options.apiKey || process.env.MINIMAX_API_KEY,
    );
    checks.push({
        id: "security_scan",
        passed: securityScan.findings.length === 0,
        required: true,
        detail: securityScan.findings.length === 0
            ? `扫描 ${securityScan.scanned_files} 个文本产物，未发现凭据`
             : `发现 ${securityScan.findings.length} 项敏感信息`,
    });
    report.status = checks.filter((check) => check.required).every((check) => check.passed)
        ? "production_acceptance_passed"
        : "production_acceptance_failed";
    writeJsonAtomic(path.join(fixtureDirectory, "security-scan.json"), securityScan);
    writeJsonAtomic(reportPath, report);
    return {
        status: report.status,
        fixtureDirectory,
        report,
        preflight,
    };
}

async function runFallbackProbes(
    manifest: StoryManifest,
    artifacts: Awaited<ReturnType<typeof runStoryPipeline>>["artifacts"],
    aligner?: ForcedAligner,
) {
    if (!aligner) {
        return {
            passed: false,
            reason: "forced_aligner_not_configured",
            segments: [],
        };
    }
    const segments = [];
    for (const segment of manifest.narration_segments) {
        const artifact = artifacts.find((candidate) => candidate.segmentId === segment.id);
        if (!artifact) throw new Error(`找不到金丝雀旁白产物：${segment.id}`);
        const local = await resolveAlignment({
            segmentId: segment.id,
            sourceText: segment.text,
            providerTimestamps: { words: [] },
            audioPath: artifact.normalizedAudioPath,
            audioDurationSamples: artifact.durationSamples,
            forcedAligner: aligner,
        });
        segments.push({
            segment_id: segment.id,
            passed: local.fallback_used && local.alignment_source === "local_forced_alignment",
            provider_alignment_source: artifact.alignmentSource,
            local_alignment_source: local.alignment_source,
            provider_validation_score: artifact.validationScore,
            local_validation_score: local.validation_score,
            provider_vs_local: compareWordTimings(artifact.words, local.words, manifest.output),
            fallback_reason: local.fallback_reason,
            words: local.words,
        });
    }
    return {
        passed: segments.every((segment) => segment.passed),
        segments,
    };
}

async function runShadowAsrProbes(
    manifest: StoryManifest,
    artifacts: Awaited<ReturnType<typeof runStoryPipeline>>["artifacts"],
    probe?: ShadowAsrProbe,
) {
    if (!probe) {
        return {
            passed: false,
            reason: "shadow_asr_not_configured",
            segments: [],
        };
    }
    const segments: Array<{
        segment_id: string;
        passed: boolean;
        result: ShadowAsrResult;
    }> = [];
    for (const segment of manifest.narration_segments) {
        const artifact = artifacts.find((candidate) => candidate.segmentId === segment.id);
        if (!artifact) throw new Error(`找不到影子 ASR 旁白产物：${segment.id}`);
        const result = await probe.shadowAsr({
            segmentId: segment.id,
            audioPath: artifact.normalizedAudioPath,
            text: segment.text,
            sampleRate: AUDIO_SAMPLE_RATE,
            audioDurationSamples: artifact.durationSamples,
        });
        segments.push({
            segment_id: segment.id,
            passed: result.diagnostic_only === true
                && Number.isFinite(result.text_similarity)
                && result.text_similarity >= 0.8,
            result,
        });
    }
    return {
        passed: segments.every((segment) => segment.passed),
        segments,
    };
}

function archiveCanaryArtifacts(
    fixtureDirectory: string,
    manifest: StoryManifest,
    timeline: Awaited<ReturnType<typeof runStoryPipeline>>["timeline"],
    artifacts: Awaited<ReturnType<typeof runStoryPipeline>>["artifacts"],
    fallbackProbe: Awaited<ReturnType<typeof runFallbackProbes>>,
    shadowAsr: Awaited<ReturnType<typeof runShadowAsrProbes>>,
) {
    const requests = [];
    const responses = [];
    const providerSubtitles = [];
    const audioManifest = [];

    for (const artifact of artifacts) {
        const ttsCacheDirectory = path.dirname(artifact.sourceAudioPath);
        const request = readJsonFile<unknown>(path.join(ttsCacheDirectory, "request.json"));
        const response = readJsonFile<unknown>(path.join(ttsCacheDirectory, "response.json"));
        const providerTimestamps = readJsonFile<unknown>(artifact.providerTimestampsPath);
        const receipt = readJsonFile<Record<string, unknown>>(path.join(ttsCacheDirectory, "receipt.json"));
        const sourceInfo = readWavInfo(artifact.sourceAudioPath);
        const normalizedInfo = readWavInfo(artifact.normalizedAudioPath);
        requests.push({
            segment_id: artifact.segmentId,
            request: redactCanaryRequest(request),
        });
        responses.push({
            segment_id: artifact.segmentId,
            response: redactSecrets(response),
        });
        providerSubtitles.push({
            segment_id: artifact.segmentId,
            subtitles: redactSecrets(providerTimestamps),
        });
        audioManifest.push({
            segment_id: artifact.segmentId,
            request_hash: artifact.requestHash,
            alignment_hash: artifact.alignmentHash,
            provider_audio_hash: artifact.providerAudioHash,
            normalized_audio_hash: artifact.normalizedAudioHash,
            source_audio: sourceInfo,
            normalized_audio: normalizedInfo,
            provider_timestamp_count: normalizeProviderTimestamps(providerTimestamps).length,
            resolved_token_count: artifact.words.length,
            alignment_source: artifact.alignmentSource,
            fallback_used: artifact.fallbackUsed,
            trace_id: receipt.trace_id,
            provider_http: receipt.provider_http,
        });
    }
    writeJsonAtomic(path.join(fixtureDirectory, "story-manifest.redacted.json"), redactManifest(manifest));
    writeJsonAtomic(path.join(fixtureDirectory, "request.redacted.json"), requests);
    writeJsonAtomic(path.join(fixtureDirectory, "response.redacted.json"), responses);
    writeJsonAtomic(path.join(fixtureDirectory, "response.contract.json"), collectJsonContract(responses));
    writeJsonAtomic(path.join(fixtureDirectory, "provider-subtitles.json"), providerSubtitles);
    writeJsonAtomic(
        path.join(fixtureDirectory, "provider-subtitles.contract.json"),
        collectJsonContract(providerSubtitles),
    );
    writeJsonAtomic(path.join(fixtureDirectory, "local-alignment.json"), {
        passed: fallbackProbe.passed,
        segments: fallbackProbe.segments.map((segment) => ({
            segment_id: segment.segment_id,
            alignment_source: segment.local_alignment_source,
            validation_score: segment.local_validation_score,
            fallback_reason: segment.fallback_reason,
            words: segment.words,
        })),
    });
    writeJsonAtomic(path.join(fixtureDirectory, "alignment-comparison.json"), {
        passed: fallbackProbe.passed,
        segments: fallbackProbe.segments.map((segment) => ({
            segment_id: segment.segment_id,
            provider_alignment_source: segment.provider_alignment_source,
            provider_validation_score: segment.provider_validation_score,
            local_validation_score: segment.local_validation_score,
            provider_vs_local: segment.provider_vs_local,
        })),
    });
    writeJsonAtomic(path.join(fixtureDirectory, "shadow-asr.json"), shadowAsr);
    writeJsonAtomic(path.join(fixtureDirectory, "audio-manifest.json"), audioManifest);
    writeJsonAtomic(path.join(fixtureDirectory, "resolved_timeline.json"), timeline);
}

function buildTurboSmokeChecks(
    artifacts: Awaited<ReturnType<typeof runStoryPipeline>>["artifacts"],
): CanaryCheck[] {
    const modelValid = artifacts.every((artifact) => {
        const requestPath = path.join(path.dirname(artifact.sourceAudioPath), "request.json");
        return fs.existsSync(requestPath)
            && readJsonFile<Record<string, unknown>>(requestPath).model === "speech-2.8-turbo";
    });
    const providerContractValid = artifacts.every((artifact) => {
        const directory = path.dirname(artifact.sourceAudioPath);
        const responsePath = path.join(directory, "response.json");
        const receiptPath = path.join(directory, "receipt.json");
        if (!fs.existsSync(responsePath)
            || !fs.existsSync(receiptPath)
            || !fs.existsSync(artifact.providerTimestampsPath)) {
            return false;
        }
        const receipt = readJsonFile<Record<string, unknown>>(receiptPath);
        const response = readJsonFile<unknown>(responsePath);
        readJsonFile<unknown>(artifact.providerTimestampsPath);
        return receipt.status === "complete"
            && typeof receipt.trace_id === "string"
            && collectJsonContract(response).length > 0;
    });
    const normalizedValid = artifacts.every((artifact) => {
        const info = readWavInfo(artifact.normalizedAudioPath);
        return info.sampleRate === AUDIO_SAMPLE_RATE
            && info.channels === 1
            && info.sampleCount === artifact.durationSamples
            && sha256File(artifact.normalizedAudioPath) === artifact.normalizedAudioHash;
    });
    return [
        {
            id: "turbo_model_used",
            passed: modelValid,
            required: true,
            detail: "实际规范化请求使用 speech-2.8-turbo",
        },
        {
            id: "authentication_and_voice",
            passed: artifacts.every((artifact) => !artifact.ttsCacheHit),
            required: true,
            detail: "专用 Key 与 voice_id 已完成一次真实、非缓存请求",
        },
        {
            id: "immediate_download",
            passed: artifacts.every((artifact) => fs.existsSync(artifact.sourceAudioPath)),
            required: true,
            detail: "临时音频 URL 已在响应后立即下载",
        },
        {
            id: "provider_contract",
            passed: providerContractValid,
            required: true,
            detail: "响应、trace_id 与 Provider 字幕契约均可解析",
        },
        {
            id: "normalized_audio",
            passed: normalizedValid,
            required: true,
            detail: "44.1 kHz 音频已转为 48 kHz 单声道并重新读取采样数",
        },
    ];
}

function buildAcceptanceChecks(input: {
    firstTimelineHash: string;
    secondTimelineHash: string;
    firstArtifacts: Awaited<ReturnType<typeof runStoryPipeline>>["artifacts"];
    secondArtifacts: Awaited<ReturnType<typeof runStoryPipeline>>["artifacts"];
    fallbackProbe: Awaited<ReturnType<typeof runFallbackProbes>>;
    shadowAsr: Awaited<ReturnType<typeof runShadowAsrProbes>>;
}): CanaryCheck[] {
    const normalizedValid = input.firstArtifacts.every((artifact) => {
        const info = readWavInfo(artifact.normalizedAudioPath);
        return info.sampleRate === AUDIO_SAMPLE_RATE
            && info.channels === 1
            && info.sampleCount === artifact.durationSamples
            && sha256File(artifact.normalizedAudioPath) === artifact.normalizedAudioHash;
    });
    const receiptsValid = input.firstArtifacts.every((artifact) => {
        const receiptPath = path.join(path.dirname(artifact.sourceAudioPath), "receipt.json");
        const alignmentReceiptPath = path.join(artifact.alignmentDirectory, "receipt.json");
        if (!fs.existsSync(receiptPath)) return false;
        const receipt = readJsonFile<Record<string, unknown>>(receiptPath);
        const alignmentReceipt = fs.existsSync(alignmentReceiptPath)
            ? readJsonFile<Record<string, unknown>>(alignmentReceiptPath)
            : undefined;
        const providerHttp = receipt.provider_http as Record<string, unknown> | undefined;
        return receipt.status === "complete"
            && typeof receipt.trace_id === "string"
            && receipt.trace_id.length > 0
            && providerHttp?.status === 200
            && alignmentReceipt?.status === "complete"
            && alignmentReceipt.alignment_hash === artifact.alignmentHash;
    });
    const responseExtraInfoObserved = input.firstArtifacts.every((artifact) => {
        const responsePath = path.join(path.dirname(artifact.sourceAudioPath), "response.json");
        if (!fs.existsSync(responsePath)) return false;
        const response = readJsonFile<Record<string, unknown>>(responsePath);
        return Boolean(response.extra_info && typeof response.extra_info === "object");
    });
    const rateLimitHeadersObserved = input.firstArtifacts.some((artifact) => {
        const metadataPath = path.join(path.dirname(artifact.sourceAudioPath), "http_metadata.json");
        if (!fs.existsSync(metadataPath)) return false;
        const metadata = readJsonFile<{ headers?: Record<string, string> }>(metadataPath);
        return Object.keys(metadata.headers || {}).some((name) => name.includes("ratelimit") || name.includes("rate-limit"));
    });
    const providerTimestampsObserved = input.firstArtifacts.every((artifact) => {
        const timestampPath = artifact.providerTimestampsPath;
        return fs.existsSync(timestampPath)
            && normalizeProviderTimestamps(readJsonFile<unknown>(timestampPath)).length > 0;
    });
    const finalModelUsed = input.firstArtifacts.every((artifact) => {
        const requestPath = path.join(path.dirname(artifact.sourceAudioPath), "request.json");
        if (!fs.existsSync(requestPath)) return false;
        const request = readJsonFile<Record<string, unknown>>(requestPath);
        return request.model === "speech-2.8-hd";
    });
    const comparisons = input.fallbackProbe.segments.map((segment) => segment.provider_vs_local);
    const comparisonReady = comparisons.length === input.firstArtifacts.length
        && comparisons.every((comparison) => comparison.compared_tokens > 0);
    return [
        {
            id: "hd_model_used",
            passed: finalModelUsed,
            required: true,
            detail: "正式 Canary 的实际规范化请求使用 speech-2.8-hd",
        },
        {
            id: "fresh_provider_request",
            passed: input.firstArtifacts.every((artifact) => !artifact.ttsCacheHit),
            required: true,
            detail: "首轮 TTS 强制构建未复用既有完成缓存",
        },
        {
            id: "fresh_alignment",
            passed: input.firstArtifacts.every((artifact) => !artifact.alignmentCacheHit),
            required: true,
            detail: "首轮 Alignment 强制构建未复用既有完成缓存",
        },
        {
            id: "immediate_audio_download",
            passed: input.firstArtifacts.every((artifact) => fs.existsSync(artifact.sourceAudioPath)),
            required: true,
            detail: "所有 MiniMax 源 WAV 均已在响应后立即落盘",
        },
        {
            id: "normalized_audio_truth",
            passed: normalizedValid,
            required: true,
            detail: "48 kHz 单声道、采样数与内容哈希一致",
        },
        {
            id: "provider_contract_receipt",
            passed: receiptsValid,
            required: true,
            detail: "Receipt 包含成功状态、trace_id 与脱敏 HTTP 元数据",
        },
        {
            id: "provider_extra_info",
            passed: responseExtraInfoObserved,
            required: true,
            detail: "真实响应保留脱敏后的 extra_info/用量元数据",
        },
        {
            id: "provider_word_timestamps_observed",
            passed: providerTimestampsObserved,
            required: false,
            detail: providerTimestampsObserved
                ? "真实 subtitle_file 可解析出词级时间戳"
                : "Provider 未返回可解析词级时间戳，已由本地对齐接管",
        },
        {
            id: "rate_limit_headers_observed",
            passed: rateLimitHeadersObserved,
            required: false,
            detail: rateLimitHeadersObserved
                ? "成功响应包含限流诊断头"
                : "成功响应未返回限流头；等待自然 429 样本补充",
        },
        {
            id: "timestamp_resolution",
            passed: input.firstArtifacts.every((artifact) => artifact.words.length > 0 && artifact.validationScore >= 0.98),
            required: true,
            detail: "所有旁白段均得到通过质量门的稳定词元时间戳",
        },
        {
            id: "forced_alignment_probe",
            passed: input.fallbackProbe.passed,
            required: true,
            detail: input.fallbackProbe.passed ? "本地强制对齐已对真实 WAV 接管成功" : "本地强制对齐探针失败",
        },
        {
            id: "provider_local_timing_comparison",
            passed: comparisonReady,
            required: true,
            detail: comparisonReady
                ? `${comparisons.length} 个旁白段均已生成 Provider/Local 帧差指标`
                : "未得到 Provider 与本地对齐比较结果",
        },
        {
            id: "shadow_asr_probe",
            passed: input.shadowAsr.passed,
            required: true,
            detail: input.shadowAsr.passed
                ? "faster-whisper 影子 ASR 已完成，且所有段相似度不低于 0.8"
                : "faster-whisper 影子 ASR 未完成或相似度未达诊断门槛",
        },
        {
            id: "second_run_tts_cache_hit",
            passed: input.secondArtifacts.every((artifact) => artifact.ttsCacheHit),
            required: true,
            detail: "第二次执行直接命中 TTS 缓存，不再调用 MiniMax 或下载临时 URL",
        },
        {
            id: "second_run_alignment_cache_hit",
            passed: input.secondArtifacts.every((artifact) => artifact.alignmentCacheHit),
            required: true,
            detail: "第二次执行独立命中 Alignment 缓存",
        },
        {
            id: "deterministic_timeline",
            passed: input.firstTimelineHash === input.secondTimelineHash,
            required: true,
            detail: "两次 resolved_timeline.json 的 SHA-256 完全一致",
        },
    ];
}

function scanFixtureFiles(filePaths: string[], apiKey?: string) {
    const findings: Array<{ file: string; rule: string }> = [];
    let scannedFiles = 0;
    for (const filePath of filePaths) {
        if (path.extname(filePath).toLowerCase() === ".wav") continue;
        scannedFiles += 1;
        const text = fs.readFileSync(filePath, "utf8");
        if (apiKey && text.includes(apiKey)) findings.push({ file: filePath, rule: "runtime_api_key" });
        for (const [rule, pattern] of [
            ["authorization_header", /\bAuthorization\s*[:=]\s*(?!["']?\[REDACTED\])/i],
            ["bearer_token", /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}/i],
            ["secret_key", /\bsk-[A-Za-z0-9_-]{12,}/i],
            ["signed_url", /[?&](?:access_token|token|signature|sig|api_key|key|credential)=(?!\[REDACTED\])[^&#\s"']+/i],
        ] as const) {
            if (pattern.test(text)) findings.push({ file: filePath, rule });
        }
    }
    const safeFindings = redactSecrets(findings) as typeof findings;
    return {
        scanned_files: scannedFiles,
        findings: safeFindings,
    };
}

function redactCanaryRequest(value: unknown) {
    const sanitized = structuredClone(value) as unknown;
    if (sanitized && typeof sanitized === "object") {
        const voiceSetting = (sanitized as Record<string, unknown>).voice_setting;
        if (voiceSetting && typeof voiceSetting === "object" && "voice_id" in voiceSetting) {
            (voiceSetting as Record<string, unknown>).voice_id = "[VOICE_ID_REDACTED]";
        }
    }
    return redactSecrets(sanitized);
}

function redactManifest(manifest: StoryManifest) {
    const sanitized = structuredClone(manifest);
    for (const profile of Object.values(sanitized.voice_profiles)) {
        profile.voice_id = "[VOICE_ID_REDACTED]";
    }
    return redactSecrets(sanitized);
}

function listFixtureFiles(directory: string): string[] {
    const output: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) output.push(...listFixtureFiles(filePath));
        else if (entry.isFile()) output.push(filePath);
    }
    return output;
}

function listFixtureTextFiles(directory: string) {
    return listFixtureFiles(directory).filter((filePath) =>
        [".json", ".txt", ".md", ".csv"].includes(path.extname(filePath).toLowerCase()));
}

function collectJsonContract(value: unknown) {
    const contract = new Map<string, Set<string>>();
    const visit = (current: unknown, pointer: string) => {
        const type = jsonType(current);
        const values = contract.get(pointer) || new Set<string>();
        values.add(type);
        contract.set(pointer, values);
        if (Array.isArray(current)) {
            current.forEach((item) => visit(item, `${pointer}/*`));
        } else if (current && typeof current === "object") {
            Object.entries(current as Record<string, unknown>)
                .sort(([first], [second]) => first.localeCompare(second))
                .forEach(([key, child]) => visit(child, `${pointer}/${escapeJsonPointer(key)}`));
        }
    };
    visit(value, "");
    return [...contract.entries()].map(([pointer, types]) => ({ pointer: pointer || "/", types: [...types].sort() }));
}

function compareWordTimings(
    provider: Array<{ start_sample: number; end_sample: number; text: string }>,
    local: Array<{ start_sample: number; end_sample: number; text: string }>,
    timebase: StoryManifest["output"],
) {
    const count = Math.min(provider.length, local.length);
    const differences = Array.from({ length: count }, (_value, index) => {
        const start = Math.abs(provider[index].start_sample - local[index].start_sample);
        const end = Math.abs(provider[index].end_sample - local[index].end_sample);
        return Math.max(samplesToFrames(start, timebase), samplesToFrames(end, timebase));
    }).sort((first, second) => first - second);
    return {
        compared_tokens: count,
        provider_tokens: provider.length,
        local_tokens: local.length,
        median_difference_frames: percentile(differences, 0.5),
        p95_difference_frames: percentile(differences, 0.95),
        maximum_difference_frames: differences.at(-1) || 0,
    };
}

function percentile(values: number[], ratio: number) {
    if (values.length === 0) return null;
    return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
}

function executableExists(value: string) {
    if (!value) return false;
    if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) return fs.existsSync(value);
    const result = spawnSync("where.exe", [value], { windowsHide: true, stdio: "ignore" });
    return result.status === 0;
}

function inspectAligner(executable: string, ffmpegPath: string, injected: boolean) {
    if (injected) {
        return { ready: true, detail: "测试已注入本地强制对齐器" };
    }
    if (!executableExists(executable)) {
        return {
            ready: false,
            detail: "缺少 STORY_ALIGNER_EXECUTABLE 或 --aligner",
        };
    }
    const result = spawnSync(executable, ["doctor", "--json"], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 60_000,
        env: {
            ...process.env,
            ...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {}),
        },
    });
    if (result.status !== 0) {
        const diagnostic = (result.stderr || result.stdout || `退出码 ${result.status ?? "unknown"}`)
            .trim()
            .slice(0, 500);
        return {
            ready: false,
            detail: `本地对齐器 doctor 未通过：${diagnostic}`,
        };
    }
    try {
        const report = JSON.parse(result.stdout) as {
            ready?: boolean;
            cache_identity?: { name?: string; model?: string; device?: string };
        };
        const identity = report.cache_identity;
        return {
            ready: report.ready === true,
            detail: report.ready === true
                ? `${identity?.name || "本地对齐器"} / ${identity?.model || "未知模型"} / ${identity?.device || "未知设备"}`
                : "本地对齐器 doctor 返回未就绪",
        };
    } catch {
        return {
            ready: false,
            detail: "本地对齐器 doctor 未返回有效 JSON",
        };
    }
}

function isPlaceholder(value: string) {
    return /(?:replace|fixture|example|your[-_ ]|placeholder)/i.test(value);
}

function jsonType(value: unknown) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function escapeJsonPointer(value: string) {
    return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function formatTimestamp(value: Date) {
    return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
