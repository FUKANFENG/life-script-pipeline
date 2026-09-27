import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { tokenizeNarration } from "../../canvas-agent/dist/story-pipeline/tokenization.js";

const root = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node build_story_manifest.mjs <project-root>");

const storyPlan = readJson(path.join(root, "story-plan.json"));
const projectId = storyPlan.project_id || "reborn-2006-2026-demo-2026-07-31";
const title = storyPlan.title || "刚出生的你，带着二十年记忆赚到三百八十六亿";

const manifest = buildManifest(storyPlan.shots, {
    projectId,
    title,
    segmentSize: 5,
});
const smokeManifest = buildManifest(storyPlan.shots.slice(0, 2), {
    projectId: `${projectId}-tts-smoke`,
    title: `${title} MiniMax Turbo Smoke`,
    segmentSize: 2,
});

writeJson(path.join(root, "story_manifest.json"), manifest);
writeJson(path.join(root, "tts-smoke-manifest.json"), smokeManifest);
process.stdout.write(JSON.stringify({
    storyManifest: path.join(root, "story_manifest.json"),
    smokeManifest: path.join(root, "tts-smoke-manifest.json"),
    narrationSegments: manifest.narration_segments.length,
    shots: manifest.shots.length,
    stableTokens: manifest.narration_segments.reduce((total, segment) => total + tokenizeNarration(segment.text).length, 0),
}));

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
            text: textParts.join("<#0.22#>"),
            delivery: {
                target_pace: segmentPace(group),
                emotion: null,
                pause_after_ms: start + options.segmentSize < shots.length ? 280 : 0,
            },
        });
    }

    return {
        schema_version: "1.0",
        tokenizer_version: "story-tokenizer/1",
        project_id: options.projectId,
        title: options.title,
        output: { fps_num: 30, fps_den: 1, width: 1920, height: 1080 },
        voice_profiles: {
            narrator: {
                provider: "minimax",
                draft_model: "speech-2.8-turbo",
                final_model: "speech-2.8-hd",
                voice_id: "Chinese (Mandarin)_Radio_Host",
                speed: 0.98,
                vol: 1,
                pitch: -1,
                emotion: null,
                language_boost: "Chinese",
                pronunciation_profile: "rebirth-dictionary",
            },
        },
        pronunciation_profiles: {
            "rebirth-dictionary": {
                tone: [
                    "林川/(lin2)(chuan1)",
                    "星火/(xing1)(huo3)",
                    "比特币/(bi3)(te4)(bi4)",
                    "以太坊/(yi3)(tai4)(fang1)",
                    "区块链/(qu1)(kuai4)(lian4)",
                    "算力/(suan4)(li4)",
                    "液冷/(ye4)(leng3)",
                ],
            },
        },
        narration_segments: narrationSegments,
        assets: shots.map((shot) => imageAsset(shot)),
        shots: shots.map((shot, index) => ({
            id: shot.id,
            image_asset_id: `IMG${shot.id.slice(1)}`,
            narration_refs: [shotReferences.get(shot.id)],
            pace_intent: shotPace(shot),
            motion_intent: {
                type: shot.motion || motionForIndex(index),
                subject_anchor: { x: 0.5, y: 0.47 },
                strength: 0.28,
            },
            transition_out: transitionForShot(shots, index),
            sound_effects: [],
        })),
    };
}

function imageAsset(shot) {
    const prepared = path.join(root, "images", "16x9", `${shot.id}.png`);
    const raw = path.join(root, "images", "raw", `${shot.id}.png`);
    const chosen = fs.existsSync(prepared) ? prepared : fs.existsSync(raw) ? raw : prepared;
    return {
        id: `IMG${shot.id.slice(1)}`,
        type: "image",
        path: path.relative(root, chosen).replaceAll("\\", "/"),
        ...(fs.existsSync(chosen) ? { content_sha256: sha256File(chosen) } : {}),
        prompt: shot.prompt || shot.visual,
    };
}

function segmentPace(group) {
    const chapter = Number(group[0]?.chapter || 1);
    if (chapter === 1 || chapter === 5 || chapter === 7) return "fast";
    if (chapter === 2 || chapter === 11 || chapter === 12) return "slow";
    return "medium";
}

function shotPace(shot) {
    const seconds = Number(shot.estimated_duration_seconds || 6);
    if (seconds >= 8) return "very_slow";
    if (seconds >= 6) return "calm";
    if (seconds <= 4) return "fast";
    return "medium";
}

function motionForIndex(index) {
    return ["slow_push_in", "static", "pan_right", "slow_pull_out", "pan_left"][index % 5];
}

function transitionForShot(shots, index) {
    if (index === shots.length - 1) return { type: "fade", duration_frames: 24 };
    const chapterBoundary = shots[index + 1]?.chapter !== shots[index]?.chapter;
    return chapterBoundary
        ? { type: "dissolve", duration_frames: 12 }
        : { type: "cut", duration_frames: 0 };
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
