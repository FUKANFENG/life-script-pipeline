import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StoryReviewStore } from "./store.js";

test("imports a shot project and keeps timeline fixed while replacing images", async () => {
    const workspace = await fixtureWorkspace();
    const store = new StoryReviewStore(workspace);
    const initial = await store.project("canvas-demo");
    assert.equal(initial.shots.length, 1);
    assert.equal(initial.timeline.totalFrames, 30);
    assert.equal(initial.shots[0].selectedVersionId, "v001");
    assert.deepEqual(initial.shots[0].imageReferences.map((item: { id: string }) => item.id), ["style", "asset:character:P", "asset:location:LOC"]);
    assert.equal((await readFile(await store.referenceImage("canvas-demo", "asset:character:P"))).toString(), "character-image");
    assert.equal((await readFile(await store.referenceImage("canvas-demo", "asset:location:LOC"))).toString(), "location-image");

    const addedReference = await store.addCustomReference("canvas-demo", "S001", {
        dataUrl: `data:image/png;base64,${Buffer.from("character-reference").toString("base64")}`,
        width: 900,
        height: 1200,
        label: "主角",
    });
    assert.equal(addedReference.project.shots[0].customReferences.length, 1);
    assert.equal(addedReference.project.shots[0].customReferences[0].label, "主角");
    assert.equal(addedReference.project.shots[0].customReferences[0].active, true);
    assert.equal("file" in addedReference.project.shots[0].customReferences[0], false);

    const mutation = await store.addVersion("canvas-demo", "S001", {
        dataUrl: `data:image/png;base64,${Buffer.from("replacement-image").toString("base64")}`,
        source: "uploaded",
        width: 1600,
        height: 900,
        note: "manual replacement",
        referenceIds: ["ref-001"],
    });
    assert.equal(mutation.project.shots[0].selectedVersionId, "v002");
    assert.equal(mutation.project.shots[0].versions.length, 2);
    assert.equal(mutation.project.timeline.totalFrames, 30);
    assert.equal(mutation.project.timeline.totalSamples, 48_000);
    assert.deepEqual(mutation.project.shots[0].versions[1].referenceIds, ["ref-001"]);

    const referenceFile = await store.customReferenceImage("canvas-demo", "S001", "ref-001");
    assert.equal((await readFile(referenceFile)).toString(), "character-reference");
    const removedReference = await store.removeCustomReference("canvas-demo", "S001", "ref-001");
    assert.equal(removedReference.project.shots[0].customReferences[0].active, false);
    assert.deepEqual(removedReference.project.shots[0].versions[1].referenceIds, ["ref-001"]);
    assert.equal((await readFile(await store.customReferenceImage("canvas-demo", "S001", "ref-001"))).toString(), "character-reference");

    const selected = await store.selectVersion("canvas-demo", "S001", "v001");
    assert.equal(selected.project.shots[0].selectedVersionId, "v001");
    assert.equal(selected.project.shots[0].versions.length, 2);
    const persisted = JSON.parse(await readFile(path.join(workspace, "outputs", "demo", "review", "review-project.json"), "utf8"));
    assert.equal(persisted.shots[0].versions.length, 2);
});

test("rejects invalid project identifiers", async () => {
    const store = new StoryReviewStore(await fixtureWorkspace());
    await assert.rejects(() => store.project("../outside"), /项目标识无效/);
});

async function fixtureWorkspace() {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "story-review-"));
    const root = path.join(workspace, "outputs", "demo");
    await mkdir(path.join(root, "frames-16x9"), { recursive: true });
    await mkdir(path.join(root, "deliverables"), { recursive: true });
    await writeFile(path.join(root, "frames-16x9", "S001.png"), Buffer.from("original-image"));
    await writeFile(path.join(root, "style.png"), Buffer.from("style-image"));
    await writeFile(path.join(root, "character.png"), Buffer.from("character-image"));
    await writeFile(path.join(root, "location.png"), Buffer.from("location-image"));
    await writeFile(path.join(root, "deliverables", "audio.wav"), Buffer.from("audio"));
    await writeFile(path.join(root, "deliverables", "subtitles.srt"), "1\n00:00:00,000 --> 00:00:01,000\n测试\n", "utf8");
    await writeFile(path.join(root, "shot_manifest.json"), JSON.stringify({
        project: "Demo",
        timeline: { total_frames: 30, total_samples: 48_000, total_seconds: 1 },
        shots: [{ id: "S001", chapter_id: "C01", scene_id: "SC01", location_id: "LOC", characters: ["P"], function: "开场", visual: "主角进入房间", composition: "中景", prompt: "主角", narration: { vo: "VO001", source_excerpt: "测试", start_sample: 0, end_sample: 48_000, start_seconds: 0, end_seconds: 1, duration_seconds: 1, start_frame: 0, end_frame: 30 } }],
    }), "utf8");
    await writeFile(path.join(root, "media-export-manifest.json"), JSON.stringify({ project_id: "canvas-demo", files: [{ shot_id: "S001", file: path.join(root, "frames-16x9", "S001.png"), mime_type: "image/png", width: 1600, height: 900 }] }), "utf8");
    await writeFile(path.join(root, "ASSET_BIBLE.json"), JSON.stringify({ style: { description: "soft illustration", master: "style.png" }, characters: [{ id: "P", name: "主角", identity_lock: "black hair", referenceFile: "character.png" }], locations: [{ id: "LOC", name: "房间", lock: "same layout", referenceFile: "location.png" }], props: [] }), "utf8");
    return workspace;
}
