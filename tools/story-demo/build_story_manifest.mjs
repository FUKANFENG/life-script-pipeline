import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tokenizeNarration } from "../../canvas-agent/dist/story-pipeline/tokenization.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const root = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node build_story_manifest.mjs <demo-root>");

const storyPlan = readJson(path.join(root, "story-plan.json"));
const imageManifest = readJson(path.join(root, "image-preparation-manifest.json"));
const imageByShot = new Map(imageManifest.records.map((record) => [record.shotId, record]));
const voiceId = "Chinese (Mandarin)_Radio_Host";

const manifest = buildManifest(storyPlan.shots, {
    projectId: "tide-photo-studio-demo-2026-07-31",
    title: storyPlan.title || "潮汐之后，照相馆还亮着灯",
    segmentSize: 5,
});
const smokeManifest = buildManifest(storyPlan.shots.slice(0, 2), {
    projectId: "tide-photo-studio-minimax-smoke",
    title: "潮汐之后 MiniMax Turbo Smoke",
    segmentSize: 2,
});

writeJson(path.join(root, "story_manifest.json"), manifest);
writeJson(path.join(root, "tts-smoke-manifest.json"), smokeManifest);
process.stdout.write(
    JSON.stringify({
        storyManifest: path.join(root, "story_manifest.json"),
        smokeManifest: path.join(root, "tts-smoke-manifest.json"),
        narrationSegments: manifest.narration_segments.length,
        shots: manifest.shots.length,
        stableTokens: manifest.narration_segments.reduce(
            (total, segment) => total + tokenizeNarration(segment.text).length,
            0,
        ),
    }),
);

function buildManifest(shots, options) {
    const narrationSegments = [];
    const shotReferences = new Map();

    for (let start = 0; start < shots.length; start += options.segmentSize) {
        const group = shots.slice(start, start + options.segmentSize);
        const segmentId = `VO${String(narrationSegments.length + 1).padStart(3, "0")}`;
        let tokenOffset = 0;
        const textParts = [];
        for (const shot of group) {
            const text = String(shot.narration || "").trim();
            const tokenCount = tokenizeNarration(text).length;
            if (!tokenCount) throw new Error(`Shot ${shot.id} has no narration tokens`);
            shotReferences.set(shot.id, {
                segment_id: segmentId,
                range: { from_token: tokenOffset, to_token: tokenOffset + tokenCount },
            });
            tokenOffset += tokenCount;
            textParts.push(text);
        }
        narrationSegments.push({
            id: segmentId,
            speaker_id: "narrator",
            text: textParts.join("<#0.25#>"),
            delivery: {
                target_pace: segmentPace(group),
                emotion: segmentEmotion(group),
                pause_after_ms: start + options.segmentSize < shots.length ? 250 : 0,
            },
        });
    }

    return {
        schema_version: "1.0",
        tokenizer_version: "story-tokenizer/1",
        project_id: options.projectId,
        title: options.title,
        output: {
            fps_num: 30,
            fps_den: 1,
            width: 1920,
            height: 1080,
        },
        voice_profiles: {
            narrator: {
                provider: "minimax",
                draft_model: "speech-2.8-turbo",
                final_model: "speech-2.8-hd",
                voice_id: voiceId,
                speed: 0.98,
                vol: 1,
                pitch: -1,
                emotion: null,
                language_boost: "Chinese",
                pronunciation_profile: "story-dictionary",
            },
        },
        pronunciation_profiles: {
            "story-dictionary": {
                tone: [
                    "林舟/(lin2)(zhou1)",
                    "林守义/(lin2)(shou3)(yi4)",
                    "夏雨/(xia4)(yu3)",
                    "暗房/(an4)(fang2)",
                ],
            },
        },
        narration_segments: narrationSegments,
        assets: shots.map((shot) => {
            const image = imageByShot.get(shot.id);
            if (!image) throw new Error(`Missing prepared image for ${shot.id}`);
            const absolutePath = path.resolve(image.targetPath);
            const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/");
            return {
                id: `IMG${shot.id.slice(1)}`,
                type: "image",
                path: relativePath,
                content_sha256: image.targetSha256 || sha256File(absolutePath),
                prompt: shot.visual,
            };
        }),
        shots: shots.map((shot, index) => ({
            id: shot.id,
            image_asset_id: `IMG${shot.id.slice(1)}`,
            narration_refs: [shotReferences.get(shot.id)],
            pace_intent: shotPace(shot.id),
            motion_intent: motionIntent(index, shot.id),
            transition_out: transitionForShot(shot.id, index === shots.length - 1),
            sound_effects: soundEffectsForShot(shot.id),
        })),
    };
}

function segmentPace(group) {
    const first = Number(group[0].id.slice(1));
    if (first >= 36 && first <= 50) return "fast";
    if (first >= 51) return "slow";
    return "medium";
}

function segmentEmotion(group) {
    const first = Number(group[0].id.slice(1));
    if (first >= 36 && first <= 50) return "fearful";
    if (first >= 51) return "calm";
    return null;
}

function shotPace(shotId) {
    const number = Number(shotId.slice(1));
    if (number >= 38 && number <= 50) return "medium";
    if ([5, 20, 21, 22, 35, 37, 54, 55, 56, 60].includes(number)) return "very_slow";
    return "calm";
}

function motionIntent(index, shotId) {
    const types = [
        "slow_push_in",
        "custom_crop_interpolation",
        "pan_right",
        "slow_pull_out",
        "pan_left",
    ];
    const number = Number(shotId.slice(1));
    const type = [8, 14, 16, 20, 45, 47, 52, 55, 58].includes(number)
        ? "custom_crop_interpolation"
        : types[index % types.length];
    return {
        type,
        subject_anchor: subjectAnchor(number),
        strength: number >= 38 && number <= 50 ? 0.6 : 0.35,
    };
}

function subjectAnchor(number) {
    if ([4, 19, 20, 38, 60].includes(number)) return { x: 0.65, y: 0.48 };
    if ([8, 14, 16, 45, 47, 52, 55, 58].includes(number)) return { x: 0.5, y: 0.52 };
    return { x: 0.5, y: 0.46 };
}

function transitionForShot(shotId, isLast) {
    if (isLast) return { type: "fade", duration_frames: 24 };
    if (["S005", "S010", "S020", "S030", "S037", "S050", "S055"].includes(shotId)) {
        return { type: "dissolve", duration_frames: 12 };
    }
    return { type: "cut", duration_frames: 0 };
}

function soundEffectsForShot(shotId) {
    const cues = {
        S002: "soft phone vibration in a quiet office",
        S004: "distant train rail ambience",
        S006: "soft coastal wind and far waves",
        S012: "old camera shutter misfire then a small mechanical click",
        S015: "darkroom tray and quiet liquid movement",
        S019: "rain on a fabric umbrella",
        S020: "single thunder flash",
        S031: "photo studio door bell and low crowd murmur",
        S038: "rising coastal wind",
        S040: "heavy typhoon rain and rattling shutters",
        S042: "flood water entering a wooden shop",
        S044: "power cut click and water ambience",
        S047: "wooden beam impact and water splash",
        S050: "old film camera shutter",
        S051: "dripping water, distant cleanup and morning birds",
        S055: "darkroom timer click and tray movement",
        S059: "gentle spring sea breeze and camera shutter",
        S060: "quiet night waves and warm room tone",
    };
    const cue = cues[shotId];
    return cue
        ? [{ id: `SFX-${shotId}`, cue, relative_position: 0.5 }]
        : [];
}

function sha256File(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

