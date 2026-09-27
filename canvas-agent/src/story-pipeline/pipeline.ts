import fs from "node:fs";
import path from "node:path";

import { sha256File } from "./canonical.js";
import { CommandForcedAligner, type ForcedAligner } from "./alignment.js";
import { AlignmentCache, type AlignmentArtifact } from "./alignment-cache.js";
import {
  ensureDirectory,
  readJsonFile,
  relativeProjectPath,
  writeJsonAtomic,
} from "./io.js";
import {
  MiniMaxTtsAdapter,
  type TtsArtifact,
  type TtsBuildMode,
} from "./minimax-tts.js";
import { resolveTimeline, type ResolvedNarrationArtifact } from "./resolver.js";
import { StoryManifestSchema, type StoryManifest } from "./schemas.js";

export interface StoryTtsSynthesizer {
  synthesize(input: {
    segment: StoryManifest["narration_segments"][number];
    profile: StoryManifest["voice_profiles"][string];
    pronunciationTone?: string[];
    mode: TtsBuildMode;
    force?: boolean;
  }): Promise<TtsArtifact>;
}

export type StoryPipelineOptions = {
  manifestPath: string;
  projectDirectory: string;
  mode?: TtsBuildMode;
  forceSegments?: string[];
  ffmpegPath?: string;
  alignerExecutable?: string;
  forcedAligner?: ForcedAligner;
  synthesizer?: StoryTtsSynthesizer;
  forceAlignmentSegments?: string[];
  alignmentMaxConcurrency?: number;
};

export type StoryPipelineArtifact = Omit<TtsArtifact, "cacheHit"> &
  Omit<AlignmentArtifact, "cacheHit"> & {
    ttsCacheHit: boolean;
    alignmentCacheHit: boolean;
    cacheHit: boolean;
  };

export async function runStoryPipeline(options: StoryPipelineOptions) {
  const projectDirectory = path.resolve(options.projectDirectory);
  const manifestPath = path.resolve(options.manifestPath);
  const manifest = StoryManifestSchema.parse(
    readJsonFile<unknown>(manifestPath),
  );
  ensureDirectory(projectDirectory);
  const buildDirectory = path.join(projectDirectory, "build", "story-pipeline");
  const ttsCacheDirectory = path.join(projectDirectory, "cache", "tts");
  const alignmentCacheDirectory = path.join(
    projectDirectory,
    "cache",
    "alignment",
  );
  const audioDirectory = path.join(buildDirectory, "audio");
  ensureDirectory(audioDirectory);

  const synthesizer =
    options.synthesizer ||
    new MiniMaxTtsAdapter({
      cacheDirectory: ttsCacheDirectory,
      ffmpegPath: options.ffmpegPath,
    });
  const forcedAligner =
    options.forcedAligner ||
    (options.alignerExecutable
      ? new CommandForcedAligner(options.alignerExecutable)
      : undefined);
  const alignmentCache = new AlignmentCache(
    alignmentCacheDirectory,
    forcedAligner,
  );
  const forceSegments = new Set(options.forceSegments || []);
  const forceAlignmentSegments = new Set(
    options.forceAlignmentSegments || options.forceSegments || [],
  );
  const mode = options.mode || "draft";
  const ttsArtifacts = await Promise.all(
    manifest.narration_segments.map(async (segment) => {
      const profile = manifest.voice_profiles[segment.speaker_id];
      const pronunciation = profile.pronunciation_profile
        ? manifest.pronunciation_profiles[profile.pronunciation_profile]
        : undefined;
      return synthesizer.synthesize({
        segment,
        profile,
        pronunciationTone: pronunciation?.tone,
        mode,
        force: forceSegments.has(segment.id),
      });
    }),
  );
  const alignmentMaxConcurrency = positiveInteger(
    options.alignmentMaxConcurrency ??
      Number(process.env.STORY_ALIGNMENT_MAX_CONCURRENCY || 1),
    "alignmentMaxConcurrency",
  );
  const artifacts = await mapWithConcurrency(
    ttsArtifacts,
    alignmentMaxConcurrency,
    async (ttsArtifact, index) => {
      const segment = manifest.narration_segments[index];
      const alignment = await alignmentCache.resolve({
        segmentId: segment.id,
        text: segment.text,
        normalizedAudioHash: ttsArtifact.normalizedAudioHash,
        normalizedAudioPath: ttsArtifact.normalizedAudioPath,
        audioDurationSamples: ttsArtifact.durationSamples,
        providerTimestampsPath: ttsArtifact.providerTimestampsPath,
        force: forceAlignmentSegments.has(segment.id),
      });
      return {
        ...ttsArtifact,
        ...alignment,
        ttsCacheHit: ttsArtifact.cacheHit,
        alignmentCacheHit: alignment.cacheHit,
        cacheHit: ttsArtifact.cacheHit && alignment.cacheHit,
      };
    },
  );
  const resolvedArtifacts = artifacts.map((artifact) =>
    materializeArtifact(projectDirectory, audioDirectory, artifact),
  );
  const timeline = resolveTimeline(manifest, resolvedArtifacts);
  const timelinePath = path.join(projectDirectory, "resolved_timeline.json");
  writeJsonAtomic(timelinePath, timeline);
  const receiptPath = path.join(buildDirectory, "resolve_receipt.json");
  writeJsonAtomic(receiptPath, {
    schema_version: "1.0",
    status: "complete",
    project_id: manifest.project_id,
    mode,
    manifest_path: relativeProjectPath(
      projectDirectory,
      copyManifestSnapshot(manifestPath, buildDirectory),
    ),
    resolved_timeline_path: relativeProjectPath(projectDirectory, timelinePath),
    resolved_timeline_sha256: sha256File(timelinePath),
    segments: artifacts.map((artifact) => ({
      segment_id: artifact.segmentId,
      request_hash: artifact.requestHash,
      normalized_audio_hash: artifact.normalizedAudioHash,
      alignment_hash: artifact.alignmentHash,
      tts_cache_hit: artifact.ttsCacheHit,
      alignment_cache_hit: artifact.alignmentCacheHit,
      alignment_source: artifact.alignmentSource,
      fallback_used: artifact.fallbackUsed,
    })),
    completed_at: new Date().toISOString(),
  });
  return {
    manifest,
    timeline,
    timelinePath,
    receiptPath,
    artifacts,
  };
}

function materializeArtifact(
  projectDirectory: string,
  audioDirectory: string,
  artifact: StoryPipelineArtifact,
): ResolvedNarrationArtifact {
  const baseName = `${safeFileName(artifact.segmentId)}.${artifact.normalizedAudioHash.slice(0, 12)}`;
  const audioPath = path.join(audioDirectory, `${baseName}.48000.mono.wav`);
  const timestampsPath = path.join(
    audioDirectory,
    `${baseName}.${artifact.alignmentHash.slice(0, 12)}.words.json`,
  );
  copyContentAddressedFile(
    artifact.normalizedAudioPath,
    audioPath,
    artifact.normalizedAudioHash,
  );
  copyContentAddressedFile(
    artifact.resolvedTimestampsPath,
    timestampsPath,
    sha256File(artifact.resolvedTimestampsPath),
  );
  return {
    segmentId: artifact.segmentId,
    requestHash: artifact.requestHash,
    providerAudioHash: artifact.providerAudioHash,
    normalizedAudioHash: artifact.normalizedAudioHash,
    alignmentHash: artifact.alignmentHash,
    audioPath: relativeProjectPath(projectDirectory, audioPath),
    timestampsPath: relativeProjectPath(projectDirectory, timestampsPath),
    durationSamples: artifact.durationSamples,
    words: artifact.words,
    alignmentSource: artifact.alignmentSource,
    fallbackUsed: artifact.fallbackUsed,
    validationScore: artifact.validationScore,
  };
}

function copyContentAddressedFile(
  sourcePath: string,
  destinationPath: string,
  expectedHash: string,
) {
  if (
    fs.existsSync(destinationPath) &&
    sha256File(destinationPath) === expectedHash
  )
    return;
  ensureDirectory(path.dirname(destinationPath));
  const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(sourcePath, temporaryPath);
  if (sha256File(temporaryPath) !== expectedHash) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`复制产物后哈希不一致：${sourcePath}`);
  }
  if (fs.existsSync(destinationPath)) fs.rmSync(destinationPath);
  fs.renameSync(temporaryPath, destinationPath);
}

function copyManifestSnapshot(manifestPath: string, buildDirectory: string) {
  const destinationPath = path.join(
    buildDirectory,
    "story_manifest.snapshot.json",
  );
  const sourceHash = sha256File(manifestPath);
  copyContentAddressedFile(manifestPath, destinationPath, sourceHash);
  return destinationPath;
}

function safeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  worker: (value: Input, index: number) => Promise<Output>,
) {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await worker(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}
