import { canonicalJsonSha256 } from "./canonical.js";
import {
    ResolvedTimelineSchema,
    type ResolvedTimeline,
    type StoryManifest,
    type StoryShot,
    type WordTimestamp,
} from "./schemas.js";
import {
    AUDIO_SAMPLE_RATE,
    framesToSamples,
    framesToSeconds,
    ROUNDING_POLICY,
    samplesToFrames,
    samplesToSeconds,
    type VideoTimebase,
} from "./timebase.js";
import { STORY_TOKENIZER_VERSION } from "./tokenization.js";

export const TIMELINE_RESOLVER_VERSION = "timeline-resolver/1";

export type ResolvedNarrationArtifact = {
    segmentId: string;
    requestHash: string;
    providerAudioHash: string;
    normalizedAudioHash: string;
    alignmentHash: string;
    audioPath: string;
    timestampsPath: string;
    durationSamples: number;
    words: WordTimestamp[];
    alignmentSource: "minimax_word" | "local_forced_alignment";
    fallbackUsed: boolean;
    validationScore: number;
};

type SegmentPlacement = ResolvedNarrationArtifact & {
    speakerId: string;
    startSample: number;
    pauseAfterSamples: number;
};

/** 将创作事实与 TTS 产物求解为只含播放事实的时间线。 */
export function resolveTimeline(
    manifest: StoryManifest,
    artifacts: ResolvedNarrationArtifact[],
): ResolvedTimeline {
    const timebase: VideoTimebase = {
        fps_num: manifest.output.fps_num,
        fps_den: manifest.output.fps_den,
    };
    const artifactBySegment = new Map(artifacts.map((artifact) => [artifact.segmentId, artifact]));
    const placements: SegmentPlacement[] = [];
    let narrationCursor = 0;
    for (const segment of manifest.narration_segments) {
        const artifact = artifactBySegment.get(segment.id);
        if (!artifact) throw new Error(`缺少旁白段 TTS 产物：${segment.id}`);
        if (artifact.durationSamples <= 0 || !Number.isSafeInteger(artifact.durationSamples)) {
            throw new Error(`旁白段采样数无效：${segment.id}`);
        }
        const pauseAfterSamples = Math.round(segment.delivery.pause_after_ms * AUDIO_SAMPLE_RATE / 1_000);
        placements.push({
            ...artifact,
            speakerId: segment.speaker_id,
            startSample: narrationCursor,
            pauseAfterSamples,
        });
        narrationCursor += artifact.durationSamples + pauseAfterSamples;
    }

    const placementBySegment = new Map(placements.map((placement) => [placement.segmentId, placement]));
    const videoEvents = resolveVideoEvents(manifest, placementBySegment, narrationCursor, timebase);
    const transitionOverlaps = videoEvents.flatMap((event, index) => {
        if (event.transition_out.type === "cut" || event.transition_out.duration_frames === 0) return [];
        const next = videoEvents[index + 1];
        if (!next) return [];
        return [{
            from_shot_id: event.shot_id,
            to_shot_id: next.shot_id,
            type: event.transition_out.type,
            start_frame: event.start_frame + event.duration_frames - event.transition_out.duration_frames,
            duration_frames: event.transition_out.duration_frames,
        }];
    });
    const subtitleCues = placements.flatMap((placement) => placement.words.map((word, wordIndex) => {
        const startSample = placement.startSample + word.start_sample;
        const endSample = placement.startSample + word.end_sample;
        const startFrame = samplesToFrames(startSample, timebase);
        return {
            id: `SUB-${placement.segmentId}-${String(wordIndex + 1).padStart(4, "0")}`,
            segment_id: placement.segmentId,
            start_sample: startSample,
            end_sample: endSample,
            start_frame: startFrame,
            end_frame: Math.max(startFrame + 1, samplesToFrames(endSample, timebase)),
            text: word.text,
        };
    }));
    const soundEffectEvents = manifest.shots.flatMap((shot) => {
        const event = videoEvents.find((candidate) => candidate.shot_id === shot.id);
        if (!event) return [];
        return shot.sound_effects.map((effect) => {
            const startFrame = event.start_frame + Math.round((event.duration_frames - 1) * effect.relative_position);
            return {
                id: effect.id,
                shot_id: shot.id,
                cue: effect.cue,
                start_sample: framesToSamples(startFrame, timebase),
                start_frame: startFrame,
                asset_id: effect.asset_id,
            };
        });
    });

    const playbackFrames = Math.max(...videoEvents.map((event) => event.start_frame + event.duration_frames));
    const playbackSamples = Math.max(narrationCursor, framesToSamples(playbackFrames, timebase));
    return ResolvedTimelineSchema.parse({
        schema_version: "1.0",
        project_id: manifest.project_id,
        derived_from: {
            story_manifest_sha256: canonicalJsonSha256(manifest),
            resolver_version: TIMELINE_RESOLVER_VERSION,
            tokenizer_version: STORY_TOKENIZER_VERSION,
        },
        timebase: {
            video: timebase,
            audio: { sample_rate: AUDIO_SAMPLE_RATE },
            rounding_policy: ROUNDING_POLICY,
        },
        narration_segments: placements.map((placement) => ({
            id: placement.segmentId,
            speaker_id: placement.speakerId,
            request_hash: placement.requestHash,
            provider_audio_hash: placement.providerAudioHash,
            normalized_audio_hash: placement.normalizedAudioHash,
            alignment_hash: placement.alignmentHash,
            audio_path: placement.audioPath,
            start_sample: placement.startSample,
            duration_samples: placement.durationSamples,
            pause_after_samples: placement.pauseAfterSamples,
            start_seconds: samplesToSeconds(placement.startSample),
            duration_seconds: samplesToSeconds(placement.durationSamples),
            alignment_source: placement.alignmentSource,
            fallback_used: placement.fallbackUsed,
            validation_score: placement.validationScore,
            word_timestamps_path: placement.timestampsPath,
        })),
        video_events: videoEvents,
        transition_overlaps: transitionOverlaps,
        subtitle_cues: subtitleCues,
        sound_effect_events: soundEffectEvents,
        totals: {
            narration_samples: narrationCursor,
            playback_samples: playbackSamples,
            playback_frames: playbackFrames,
        },
    });
}

function resolveVideoEvents(
    manifest: StoryManifest,
    placements: Map<string, SegmentPlacement>,
    narrationSamples: number,
    timebase: VideoTimebase,
) {
    const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    const events: Array<{
        shot_id: string;
        image_asset_id: string;
        start_frame: number;
        duration_frames: number;
        start_seconds: number;
        duration_seconds: number;
        render_input_hash: string;
        transition_out: StoryShot["transition_out"];
    }> = [];

    for (const [index, shot] of manifest.shots.entries()) {
        const referencedWindow = resolveNarrationWindow(shot, placements);
        const previous = events[index - 1];
        const startFrame = previous
            ? previous.start_frame + previous.duration_frames - previous.transition_out.duration_frames
            : 0;
        const desiredEndFrame = referencedWindow
            ? samplesToFrames(referencedWindow.endSample, timebase)
            : startFrame + (shot.duration_intent?.target_frames || defaultDurationFrames(shot, timebase));
        let durationFrames = Math.max(1, desiredEndFrame - startFrame);
        if (shot.duration_intent?.min_frames) durationFrames = Math.max(durationFrames, shot.duration_intent.min_frames);
        if (shot.duration_intent?.max_frames) durationFrames = Math.min(durationFrames, shot.duration_intent.max_frames);
        if (index === manifest.shots.length - 1) {
            durationFrames = Math.max(durationFrames, samplesToFrames(narrationSamples, timebase) - startFrame);
        }
        if (shot.transition_out.duration_frames >= durationFrames) {
            throw new Error(`镜头 ${shot.id} 的转场时长必须小于镜头时长`);
        }

        const referencedAudio = [...new Set(shot.narration_refs.map((reference) => reference.segment_id))]
            .map((segmentId) => {
                const placement = placements.get(segmentId);
                if (!placement) throw new Error(`镜头 ${shot.id} 引用了不存在的旁白段：${segmentId}`);
                return {
                    segment_id: segmentId,
                    normalized_audio_hash: placement.normalizedAudioHash,
                    alignment_hash: placement.alignmentHash,
                    word_ranges: shot.narration_refs
                        .filter((reference) => reference.segment_id === segmentId)
                        .map((reference) => reference.range),
                };
            });
        const asset = assets.get(shot.image_asset_id);
        const renderInputHash = canonicalJsonSha256({
            compiler_contract: "shot-render-input/1",
            shot,
            image_asset: asset
                ? { id: asset.id, content_sha256: asset.content_sha256, path: asset.path, prompt: asset.prompt }
                : { id: shot.image_asset_id },
            referenced_audio: referencedAudio,
            duration_frames: durationFrames,
        });
        events.push({
            shot_id: shot.id,
            image_asset_id: shot.image_asset_id,
            start_frame: startFrame,
            duration_frames: durationFrames,
            start_seconds: framesToSeconds(startFrame, timebase),
            duration_seconds: framesToSeconds(durationFrames, timebase),
            render_input_hash: renderInputHash,
            transition_out: shot.transition_out,
        });
    }
    return events;
}

function resolveNarrationWindow(shot: StoryShot, placements: Map<string, SegmentPlacement>) {
    if (shot.narration_refs.length === 0) return undefined;
    let startSample = Number.POSITIVE_INFINITY;
    let endSample = 0;
    for (const reference of shot.narration_refs) {
        const placement = placements.get(reference.segment_id);
        if (!placement) throw new Error(`镜头 ${shot.id} 引用了不存在的旁白段：${reference.segment_id}`);
        if (reference.range.to_token > placement.words.length) {
            throw new Error(
                `镜头 ${shot.id} 的旁白范围越界：${reference.segment_id} 只有 ${placement.words.length} 个词元，`
                + `请求了 ${reference.range.from_token}-${reference.range.to_token}`,
            );
        }
        const first = placement.words[reference.range.from_token];
        const last = placement.words[reference.range.to_token - 1];
        startSample = Math.min(startSample, placement.startSample + first.start_sample);
        endSample = Math.max(endSample, placement.startSample + last.end_sample);
    }
    return { startSample, endSample };
}

function defaultDurationFrames(shot: StoryShot, timebase: VideoTimebase) {
    const seconds = shot.pace_intent === "very_slow"
        ? 6
        : shot.pace_intent === "calm" ? 5 : shot.pace_intent === "fast" ? 2.5 : 4;
    return Math.max(1, Math.round(seconds * timebase.fps_num / timebase.fps_den));
}
