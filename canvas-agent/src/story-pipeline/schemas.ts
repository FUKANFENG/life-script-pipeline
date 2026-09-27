import { z } from "zod";
import { STORY_TOKENIZER_VERSION, tokenizeNarration } from "./tokenization.js";

const IdentifierSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const RelativePathSchema = z.string().trim().min(1);

const SubjectAnchorSchema = z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
}).strict();

const NarrationRangeSchema = z.object({
    from_token: z.number().int().min(0),
    to_token: z.number().int().positive(),
}).strict().superRefine((value, context) => {
    if (value.to_token <= value.from_token) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "to_token 必须大于 from_token，区间采用左闭右开语义",
            path: ["to_token"],
        });
    }
});

export const VoiceProfileSchema = z.object({
    provider: z.literal("minimax"),
    draft_model: z.string().trim().min(1).default("speech-2.8-turbo"),
    final_model: z.string().trim().min(1).default("speech-2.8-hd"),
    voice_id: z.string().trim().min(1),
    speed: z.number().min(0.5).max(2).default(1),
    vol: z.number().min(0).max(10).default(1),
    pitch: z.number().int().min(-12).max(12).default(0),
    emotion: z.string().trim().min(1).nullable().default(null),
    language_boost: z.string().trim().min(1).default("Chinese"),
    pronunciation_profile: IdentifierSchema.optional(),
}).strict();

export const PronunciationProfileSchema = z.object({
    tone: z.array(z.string().trim().min(1)).default([]),
}).strict();

export const NarrationSegmentSchema = z.object({
    id: IdentifierSchema,
    speaker_id: IdentifierSchema,
    text: z.string().min(1),
    delivery: z.object({
        target_pace: z.enum(["slow", "medium", "fast"]).default("medium"),
        emotion: z.string().trim().min(1).nullable().optional(),
        pause_after_ms: z.number().int().min(0).max(30_000).default(0),
    }).strict().default({ target_pace: "medium", pause_after_ms: 0 }),
}).strict();

export const StoryAssetSchema = z.object({
    id: IdentifierSchema,
    type: z.enum(["image", "audio", "video"]),
    path: RelativePathSchema.optional(),
    content_sha256: Sha256Schema.optional(),
    prompt: z.string().optional(),
}).strict();

export const StoryShotSchema = z.object({
    id: IdentifierSchema,
    image_asset_id: IdentifierSchema,
    narration_refs: z.array(z.object({
        segment_id: IdentifierSchema,
        range: NarrationRangeSchema,
    }).strict()).default([]),
    pace_intent: z.enum(["very_slow", "calm", "medium", "fast"]).default("medium"),
    duration_intent: z.object({
        target_frames: z.number().int().positive().optional(),
        min_frames: z.number().int().positive().optional(),
        max_frames: z.number().int().positive().optional(),
    }).strict().optional(),
    motion_intent: z.object({
        type: z.string().trim().min(1),
        subject_anchor: SubjectAnchorSchema.optional(),
        strength: z.number().min(0).max(1).optional(),
    }).strict().optional(),
    transition_out: z.object({
        type: z.enum(["cut", "dissolve", "fade", "wipe"]),
        duration_frames: z.number().int().min(0).default(0),
    }).strict().default({ type: "cut", duration_frames: 0 }),
    sound_effects: z.array(z.object({
        id: IdentifierSchema,
        cue: z.string().trim().min(1),
        relative_position: z.number().min(0).max(1).default(0.5),
        asset_id: IdentifierSchema.optional(),
    }).strict()).default([]),
}).strict();

export const StoryManifestSchema = z.object({
    schema_version: z.literal("1.0"),
    tokenizer_version: z.literal(STORY_TOKENIZER_VERSION).default(STORY_TOKENIZER_VERSION),
    project_id: IdentifierSchema,
    title: z.string().trim().min(1).optional(),
    output: z.object({
        fps_num: z.number().int().positive().default(30),
        fps_den: z.number().int().positive().default(1),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
    }).strict().default({ fps_num: 30, fps_den: 1 }),
    voice_profiles: z.record(VoiceProfileSchema),
    pronunciation_profiles: z.record(PronunciationProfileSchema).default({}),
    assets: z.array(StoryAssetSchema).default([]),
    narration_segments: z.array(NarrationSegmentSchema).min(1),
    shots: z.array(StoryShotSchema).min(1),
}).strict().superRefine((manifest, context) => {
    validateUniqueIds(manifest.narration_segments, "narration_segments", context);
    validateUniqueIds(manifest.shots, "shots", context);
    validateUniqueIds(manifest.assets, "assets", context);

    const segmentIds = new Set(manifest.narration_segments.map((segment) => segment.id));
    const segmentTokenCounts = new Map(
        manifest.narration_segments.map((segment) => [segment.id, tokenizeNarration(segment.text).length]),
    );
    const assetIds = new Set(manifest.assets.map((asset) => asset.id));
    for (const [index, segment] of manifest.narration_segments.entries()) {
        const profile = manifest.voice_profiles[segment.speaker_id];
        if (!profile) {
            addReferenceIssue(context, ["narration_segments", index, "speaker_id"], `找不到 Voice Profile：${segment.speaker_id}`);
            continue;
        }
        if (profile.pronunciation_profile && !manifest.pronunciation_profiles[profile.pronunciation_profile]) {
            addReferenceIssue(
                context,
                ["voice_profiles", segment.speaker_id, "pronunciation_profile"],
                `找不到发音词典：${profile.pronunciation_profile}`,
            );
        }
    }

    for (const [shotIndex, shot] of manifest.shots.entries()) {
        if (manifest.assets.length > 0 && !assetIds.has(shot.image_asset_id)) {
            addReferenceIssue(context, ["shots", shotIndex, "image_asset_id"], `找不到图片资产：${shot.image_asset_id}`);
        }
        if (shot.duration_intent?.min_frames && shot.duration_intent.max_frames
            && shot.duration_intent.min_frames > shot.duration_intent.max_frames) {
            addReferenceIssue(context, ["shots", shotIndex, "duration_intent"], "min_frames 不能大于 max_frames");
        }
        for (const [referenceIndex, reference] of shot.narration_refs.entries()) {
            if (!segmentIds.has(reference.segment_id)) {
                addReferenceIssue(
                    context,
                    ["shots", shotIndex, "narration_refs", referenceIndex, "segment_id"],
                    `找不到旁白段：${reference.segment_id}`,
                );
            } else if (reference.range.to_token > (segmentTokenCounts.get(reference.segment_id) || 0)) {
                addReferenceIssue(
                    context,
                    ["shots", shotIndex, "narration_refs", referenceIndex, "range", "to_token"],
                    `旁白范围越界：${reference.segment_id} 只有 ${segmentTokenCounts.get(reference.segment_id)} 个稳定词元`,
                );
            }
        }
    }
});

export const WordTimestampSchema = z.object({
    index: z.number().int().min(0),
    text: z.string().min(1),
    start_sample: z.number().int().min(0),
    end_sample: z.number().int().positive(),
}).strict().superRefine((word, context) => {
    if (word.end_sample <= word.start_sample) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "end_sample 必须大于 start_sample",
            path: ["end_sample"],
        });
    }
});

export const ResolvedTimelineSchema = z.object({
    schema_version: z.literal("1.0"),
    project_id: IdentifierSchema,
    derived_from: z.object({
        story_manifest_sha256: Sha256Schema,
        resolver_version: z.string().trim().min(1),
        tokenizer_version: z.literal(STORY_TOKENIZER_VERSION),
    }).strict(),
    timebase: z.object({
        video: z.object({
            fps_num: z.number().int().positive(),
            fps_den: z.number().int().positive(),
        }).strict(),
        audio: z.object({
            sample_rate: z.literal(48_000),
        }).strict(),
        rounding_policy: z.literal("nearest_frame_ties_to_even"),
    }).strict(),
    narration_segments: z.array(z.object({
        id: IdentifierSchema,
        speaker_id: IdentifierSchema,
        request_hash: Sha256Schema,
        provider_audio_hash: Sha256Schema,
        normalized_audio_hash: Sha256Schema,
        alignment_hash: Sha256Schema,
        audio_path: RelativePathSchema,
        start_sample: z.number().int().min(0),
        duration_samples: z.number().int().positive(),
        pause_after_samples: z.number().int().min(0),
        start_seconds: z.number().min(0),
        duration_seconds: z.number().positive(),
        alignment_source: z.enum(["minimax_word", "local_forced_alignment"]),
        fallback_used: z.boolean(),
        validation_score: z.number().min(0).max(1),
        word_timestamps_path: RelativePathSchema,
    }).strict()),
    video_events: z.array(z.object({
        shot_id: IdentifierSchema,
        image_asset_id: IdentifierSchema,
        start_frame: z.number().int().min(0),
        duration_frames: z.number().int().positive(),
        start_seconds: z.number().min(0),
        duration_seconds: z.number().positive(),
        render_input_hash: Sha256Schema,
        transition_out: z.object({
            type: z.enum(["cut", "dissolve", "fade", "wipe"]),
            duration_frames: z.number().int().min(0),
        }).strict(),
    }).strict()),
    transition_overlaps: z.array(z.object({
        from_shot_id: IdentifierSchema,
        to_shot_id: IdentifierSchema,
        type: z.enum(["dissolve", "fade", "wipe"]),
        start_frame: z.number().int().min(0),
        duration_frames: z.number().int().positive(),
    }).strict()),
    subtitle_cues: z.array(z.object({
        id: IdentifierSchema,
        segment_id: IdentifierSchema,
        start_sample: z.number().int().min(0),
        end_sample: z.number().int().positive(),
        start_frame: z.number().int().min(0),
        end_frame: z.number().int().positive(),
        text: z.string().min(1),
    }).strict()),
    sound_effect_events: z.array(z.object({
        id: IdentifierSchema,
        shot_id: IdentifierSchema,
        cue: z.string().min(1),
        start_sample: z.number().int().min(0),
        start_frame: z.number().int().min(0),
        asset_id: IdentifierSchema.optional(),
    }).strict()),
    totals: z.object({
        narration_samples: z.number().int().min(0),
        playback_samples: z.number().int().positive(),
        playback_frames: z.number().int().positive(),
    }).strict(),
}).strict();

export type StoryManifest = z.infer<typeof StoryManifestSchema>;
export type StoryShot = z.infer<typeof StoryShotSchema>;
export type ResolvedTimeline = z.infer<typeof ResolvedTimelineSchema>;
export type WordTimestamp = z.infer<typeof WordTimestampSchema>;
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

function validateUniqueIds(
    values: Array<{ id: string }>,
    path: string,
    context: z.RefinementCtx,
) {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
        if (seen.has(value.id)) {
            addReferenceIssue(context, [path, index, "id"], `ID 重复：${value.id}`);
        }
        seen.add(value.id);
    }
}

function addReferenceIssue(context: z.RefinementCtx, path: Array<string | number>, message: string) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
