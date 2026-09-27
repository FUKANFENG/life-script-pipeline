import fs from "node:fs";
import path from "node:path";

import {
    DEFAULT_ALIGNMENT_THRESHOLDS,
    resolveAlignment,
    type AlignmentResult,
    type ForcedAligner,
} from "./alignment.js";
import {
    canonicalJsonSha256,
    normalizeTtsText,
    sha256,
    sha256File,
} from "./canonical.js";
import { ensureDirectory, readJsonFile, writeJsonAtomic } from "./io.js";
import { WordTimestampSchema, type WordTimestamp } from "./schemas.js";
import { safeErrorDetails } from "./security.js";
import {
    STORY_TOKENIZER_VERSION,
    stripSpeechControls,
} from "./tokenization.js";

export const ALIGNMENT_CACHE_SCHEMA = "alignment-cache/1";
export const ALIGNMENT_QUALITY_GATE_VERSION = "alignment-quality-gate/1";

export type AlignmentBackendIdentity = {
    name: string;
    model?: string;
    model_revision?: string;
    package_version?: string;
    device?: string;
    config?: Record<string, unknown>;
};

export type AlignmentArtifact = {
    alignmentHash: string;
    alignmentDirectory: string;
    resolvedTimestampsPath: string;
    alignmentReportPath: string;
    words: WordTimestamp[];
    alignmentSource: "minimax_word" | "local_forced_alignment";
    fallbackUsed: boolean;
    fallbackReason?: string;
    validationScore: number;
    cacheHit: boolean;
};

export class AlignmentCache {
    constructor(
        private readonly cacheDirectory: string,
        private readonly forcedAligner?: ForcedAligner,
    ) {}

    async resolve(input: {
        segmentId: string;
        text: string;
        normalizedAudioHash: string;
        normalizedAudioPath: string;
        audioDurationSamples: number;
        providerTimestampsPath: string;
        force?: boolean;
    }): Promise<AlignmentArtifact> {
        const backend = await describeAligner(this.forcedAligner);
        const normalizedText = stripSpeechControls(normalizeTtsText(input.text)).normalize("NFKC");
        const request = {
            schema_version: ALIGNMENT_CACHE_SCHEMA,
            segment_id: input.segmentId,
            normalized_audio_hash: input.normalizedAudioHash,
            normalized_text_hash: sha256(normalizedText),
            stable_token_protocol_version: STORY_TOKENIZER_VERSION,
            quality_gate: {
                version: ALIGNMENT_QUALITY_GATE_VERSION,
                thresholds: DEFAULT_ALIGNMENT_THRESHOLDS,
            },
            provider_timestamps_hash: sha256File(input.providerTimestampsPath),
            aligner_backend: backend,
        };
        const alignmentHash = canonicalJsonSha256(request);
        const paths = getAlignmentPaths(this.cacheDirectory, alignmentHash);
        ensureDirectory(paths.directory);
        if (input.force) archiveCurrentAttempt(paths);
        const cached = readCompleteArtifact(alignmentHash, paths);
        if (cached) return { ...cached, cacheHit: true };

        writeJsonAtomic(paths.request, request);
        try {
            const providerTimestamps = readJsonFile<unknown>(input.providerTimestampsPath);
            const alignment = await resolveAlignment({
                segmentId: input.segmentId,
                sourceText: input.text,
                providerTimestamps,
                audioPath: input.normalizedAudioPath,
                audioDurationSamples: input.audioDurationSamples,
                forcedAligner: this.forcedAligner,
            });
            writeJsonAtomic(paths.resolvedTimestamps, {
                alignment_source: alignment.alignment_source,
                fallback_used: alignment.fallback_used,
                fallback_reason: alignment.fallback_reason,
                validation_score: alignment.validation_score,
                words: alignment.words,
            });
            writeJsonAtomic(paths.alignmentReport, alignment.report);
            writeJsonAtomic(paths.receipt, {
                schema_version: "1.0",
                status: "complete",
                alignment_hash: alignmentHash,
                normalized_audio_hash: input.normalizedAudioHash,
                normalized_text_hash: request.normalized_text_hash,
                aligner_backend: backend,
                alignment_source: alignment.alignment_source,
                fallback_used: alignment.fallback_used,
                validation_score: alignment.validation_score,
                completed_at: new Date().toISOString(),
            });
            return fromAlignmentResult(alignmentHash, paths, alignment, false);
        } catch (error) {
            writeJsonAtomic(paths.receipt, {
                schema_version: "1.0",
                status: "failed",
                alignment_hash: alignmentHash,
                normalized_audio_hash: input.normalizedAudioHash,
                aligner_backend: backend,
                error: safeErrorDetails(error),
                failed_at: new Date().toISOString(),
            });
            throw error;
        }
    }
}

function readCompleteArtifact(
    alignmentHash: string,
    paths: ReturnType<typeof getAlignmentPaths>,
): Omit<AlignmentArtifact, "cacheHit"> | undefined {
    if (!fs.existsSync(paths.receipt)
        || !fs.existsSync(paths.resolvedTimestamps)
        || !fs.existsSync(paths.alignmentReport)) {
        return undefined;
    }
    try {
        const receipt = readJsonFile<Record<string, unknown>>(paths.receipt);
        if (receipt.status !== "complete" || receipt.alignment_hash !== alignmentHash) return undefined;
        const alignment = readPersistedAlignment(paths);
        return fromAlignmentResult(alignmentHash, paths, alignment, false);
    } catch {
        return undefined;
    }
}

function readPersistedAlignment(paths: ReturnType<typeof getAlignmentPaths>): AlignmentResult {
    const stored = readJsonFile<Record<string, unknown>>(paths.resolvedTimestamps);
    const words = Array.isArray(stored.words)
        ? stored.words.map((word) => WordTimestampSchema.parse(word))
        : [];
    const alignmentSource = stored.alignment_source;
    if (alignmentSource !== "minimax_word" && alignmentSource !== "local_forced_alignment") {
        throw new Error("缓存中的 alignment_source 无效");
    }
    return {
        words,
        alignment_source: alignmentSource,
        fallback_used: Boolean(stored.fallback_used),
        fallback_reason: typeof stored.fallback_reason === "string" ? stored.fallback_reason : undefined,
        validation_score: Number(stored.validation_score),
        report: readJsonFile<AlignmentResult["report"]>(paths.alignmentReport),
    };
}

function fromAlignmentResult(
    alignmentHash: string,
    paths: ReturnType<typeof getAlignmentPaths>,
    alignment: AlignmentResult,
    cacheHit: boolean,
): AlignmentArtifact {
    return {
        alignmentHash,
        alignmentDirectory: paths.directory,
        resolvedTimestampsPath: paths.resolvedTimestamps,
        alignmentReportPath: paths.alignmentReport,
        words: alignment.words,
        alignmentSource: alignment.alignment_source,
        fallbackUsed: alignment.fallback_used,
        fallbackReason: alignment.fallback_reason,
        validationScore: alignment.validation_score,
        cacheHit,
    };
}

function getAlignmentPaths(cacheDirectory: string, alignmentHash: string) {
    const directory = path.join(cacheDirectory, alignmentHash);
    return {
        directory,
        request: path.join(directory, "request.json"),
        resolvedTimestamps: path.join(directory, "timestamps.resolved.json"),
        alignmentReport: path.join(directory, "alignment_report.json"),
        receipt: path.join(directory, "receipt.json"),
        history: path.join(directory, "history"),
    };
}

function archiveCurrentAttempt(paths: ReturnType<typeof getAlignmentPaths>) {
    const files = [
        paths.request,
        paths.resolvedTimestamps,
        paths.alignmentReport,
        paths.receipt,
    ].filter((filePath) => fs.existsSync(filePath));
    if (files.length === 0) return;
    const destination = path.join(
        paths.history,
        new Date().toISOString().replace(/[:.]/g, "-"),
    );
    ensureDirectory(destination);
    for (const filePath of files) {
        fs.renameSync(filePath, path.join(destination, path.basename(filePath)));
    }
}

async function describeAligner(aligner?: ForcedAligner): Promise<AlignmentBackendIdentity | null> {
    if (!aligner) return null;
    if (aligner.identity) return aligner.identity();
    return {
        name: aligner.constructor.name || "forced-aligner",
        config: {},
    };
}
