import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AlignmentCache } from "./alignment-cache.js";
import { resolveAlignment, type ForcedAligner, type ShadowAsrProbe } from "./alignment.js";
import { runMiniMaxCanary, runMiniMaxProductionCanary } from "./canary.js";
import { canonicalJson, canonicalJsonSha256, sha256File } from "./canonical.js";
import { buildCanonicalTtsRequest, MiniMaxTtsAdapter } from "./minimax-tts.js";
import { runStoryPipeline, type StoryTtsSynthesizer } from "./pipeline.js";
import { resolveTimeline, type ResolvedNarrationArtifact } from "./resolver.js";
import { StoryManifestSchema, type StoryManifest, type WordTimestamp } from "./schemas.js";
import { redactSecrets } from "./security.js";
import { samplesToFrames } from "./timebase.js";
import { STORY_TOKENIZER_VERSION, tokenizeNarration } from "./tokenization.js";
import { normalizeWav, readWavInfo } from "./wav.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

test("Story Manifest 拒绝播放事实并验证跨对象引用", () => {
    const valid = riskManifest();
    assert.equal(valid.tokenizer_version, STORY_TOKENIZER_VERSION);
    const raw = {
        ...valid,
        shots: [{ ...valid.shots[0], start_frame: 12 }],
    };
    const result = StoryManifestSchema.safeParse(raw);
    assert.equal(result.success, false);

    const missingSpeaker = {
        ...valid,
        narration_segments: [{ ...valid.narration_segments[0], speaker_id: "missing" }],
    };
    assert.equal(StoryManifestSchema.safeParse(missingSpeaker).success, false);
});

test("规范化 JSON 与 TTS 请求哈希具备确定性并覆盖声音参数", () => {
    assert.equal(canonicalJson({ z: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"z":1}');
    assert.equal(canonicalJsonSha256({ b: 2, a: 1 }), canonicalJsonSha256({ a: 1, b: 2 }));

    const manifest = riskManifest();
    const segment = manifest.narration_segments[0];
    const profile = manifest.voice_profiles.narrator;
    const first = buildCanonicalTtsRequest({ segment, profile, mode: "final" });
    const second = buildCanonicalTtsRequest({ segment, profile: { ...profile, vol: 1.1 }, mode: "final" });
    assert.notEqual(canonicalJsonSha256(first), canonicalJsonSha256(second));
    assert.equal("alignment_contract" in first, false);
});

test("日志与 Receipt 脱敏不保留授权头或 API Key", () => {
    const secret = "sk-test-secret-value-123456";
    const redacted = redactSecrets({
        authorization: `Bearer ${secret}`,
        nested: {
            api_key: secret,
            message: `request failed for ${secret} at https://example.test/audio?signature=private-value`,
        },
    });
    const serialized = JSON.stringify(redacted);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("private-value"), false);
    assert.match(serialized, /REDACTED/);
});

test("时间戳未通过质量门时使用本地强制对齐并映射为稳定词元", async () => {
    const text = "重庆银行的KinoCut来信";
    const stableTokens = tokenizeNarration(text);
    const aligner: ForcedAligner = {
        async align() {
            return timedWords(stableTokens, Math.floor(7 * 48_000 / stableTokens.length));
        },
    };
    const result = await resolveAlignment({
        sourceText: text,
        providerTimestamps: {
            words: [{ text, start_ms: 0, end_ms: 7_000 }],
        },
        audioPath: "unused.wav",
        audioDurationSamples: 7 * 48_000,
        forcedAligner: aligner,
    });
    assert.equal(result.fallback_used, true);
    assert.equal(result.alignment_source, "local_forced_alignment");
    assert.deepEqual(result.words.map((word) => word.text), stableTokens);
    assert.match(result.fallback_reason || "", /sentence_not_word/);
});

test("破坏 Provider 时间戳时所有异常都强制切换到本地对齐", async (t) => {
    const text = "山河在重庆重逢";
    const stableTokens = tokenizeNarration(text);
    const audioDurationSamples = 8 * 48_000;
    const fallbackWords = timedWords(
        stableTokens,
        Math.floor(audioDurationSamples / stableTokens.length),
    );
    const validProviderWords = fallbackWords.map((word) => ({
        text: word.text,
        start_sample: word.start_sample,
        end_sample: word.end_sample,
    }));
    const cases: Array<{ name: string; timestamps: unknown; expectedReason: RegExp }> = [
        {
            name: "字幕缺失",
            timestamps: { words: [] },
            expectedReason: /coverage|missing/,
        },
        {
            name: "倒序",
            timestamps: {
                words: validProviderWords.map((word, index) => ({
                    ...word,
                    start_sample: (stableTokens.length - index - 1) * 20_000,
                    end_sample: (stableTokens.length - index - 1) * 20_000 + 10_000,
                })),
            },
            expectedReason: /monotonic/,
        },
        {
            name: "超出音频",
            timestamps: {
                words: validProviderWords.map((word, index) => index === validProviderWords.length - 1
                    ? { ...word, end_sample: audioDurationSamples + 48_000 }
                    : word),
            },
            expectedReason: /exceeds_audio/,
        },
        {
            name: "词元覆盖不足",
            timestamps: {
                words: validProviderWords.slice(0, 2),
            },
            expectedReason: /coverage/,
        },
        {
            name: "异常大空洞",
            timestamps: {
                words: validProviderWords.map((word, index) => index < 3
                    ? word
                    : {
                        ...word,
                        start_sample: word.start_sample + 120_000,
                        end_sample: word.end_sample + 120_000,
                    }),
            },
            expectedReason: /unexpected_timestamp_gap/,
        },
    ];

    for (const scenario of cases) {
        await t.test(scenario.name, async () => {
            let alignCount = 0;
            const result = await resolveAlignment({
                segmentId: "VO001",
                sourceText: text,
                providerTimestamps: scenario.timestamps,
                audioPath: "unused.wav",
                audioDurationSamples,
                forcedAligner: {
                    async align() {
                        alignCount += 1;
                        return fallbackWords;
                    },
                },
            });
            assert.equal(alignCount, 1);
            assert.equal(result.alignment_source, "local_forced_alignment");
            assert.equal(result.fallback_used, true);
            assert.match(result.fallback_reason || "", scenario.expectedReason);
        });
    }
});

test("TTS 与 Alignment 缓存独立，更换对齐模型不改变 TTS 请求哈希", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-alignment-cache-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const text = "重庆KinoCut重逢";
    const tokens = tokenizeNarration(text);
    const audioDurationSamples = tokens.length * 48_000;
    const providerTimestampsPath = path.join(directory, "provider.words.json");
    const audioPath = path.join(directory, "normalized.wav");
    fs.writeFileSync(providerTimestampsPath, JSON.stringify({ words: [] }));
    fs.writeFileSync(audioPath, createPcmWav(48_000, 1, audioDurationSamples));

    const manifest = cacheManifest(text);
    const ttsRequest = buildCanonicalTtsRequest({
        segment: manifest.narration_segments[0],
        profile: manifest.voice_profiles.narrator,
        mode: "final",
    });
    const ttsRequestHashBefore = canonicalJsonSha256(ttsRequest);
    const makeAligner = (model: string): ForcedAligner => ({
        identity() {
            return {
                name: "whisperx",
                model,
                model_revision: `${model}-revision`,
                package_version: "fixture",
                device: "cpu",
                config: { return_char_alignments: true },
            };
        },
        async align() {
            return timedWords(tokens, 48_000);
        },
    });
    const resolveInput = {
        segmentId: "VO001",
        text,
        normalizedAudioHash: sha256File(audioPath),
        normalizedAudioPath: audioPath,
        audioDurationSamples,
        providerTimestampsPath,
    };

    const modelA = new AlignmentCache(path.join(directory, "alignment"), makeAligner("model-a"));
    const first = await modelA.resolve(resolveInput);
    const cached = await modelA.resolve(resolveInput);
    const modelB = new AlignmentCache(path.join(directory, "alignment"), makeAligner("model-b"));
    const changedModel = await modelB.resolve(resolveInput);

    assert.equal(first.cacheHit, false);
    assert.equal(cached.cacheHit, true);
    assert.equal(changedModel.cacheHit, false);
    assert.equal(first.alignmentHash, cached.alignmentHash);
    assert.notEqual(first.alignmentHash, changedModel.alignmentHash);
    assert.equal(ttsRequestHashBefore, canonicalJsonSha256(ttsRequest));
});

test("整数采样映射使用最近帧且半帧舍入到偶数", () => {
    const timebase = { fps_num: 30, fps_den: 1 };
    assert.equal(samplesToFrames(800, timebase), 0);
    assert.equal(samplesToFrames(2_400, timebase), 2);
});

test("Resolver 支持跨段镜头、15 帧叠化和逐镜头选择性失效", () => {
    const manifest = riskManifest();
    const firstArtifacts = resolverArtifacts(HASH_B);
    const first = resolveTimeline(manifest, firstArtifacts);
    assert.equal(first.transition_overlaps.length, 1);
    assert.equal(first.transition_overlaps[0].duration_frames, 15);
    assert.equal(first.totals.playback_frames, 300);
    assert.equal(first.narration_segments[1].start_sample, 5 * 48_000);
    assert.equal(first.video_events[3].start_frame, first.video_events[2].start_frame + first.video_events[2].duration_frames - 15);

    const changed = resolveTimeline(manifest, resolverArtifacts(HASH_C));
    assert.equal(first.video_events[0].render_input_hash, changed.video_events[0].render_input_hash);
    assert.equal(first.video_events[1].render_input_hash, changed.video_events[1].render_input_hash);
    assert.notEqual(first.video_events[2].render_input_hash, changed.video_events[2].render_input_hash);
    assert.notEqual(first.video_events[3].render_input_hash, changed.video_events[3].render_input_hash);
    assert.notEqual(first.video_events[4].render_input_hash, changed.video_events[4].render_input_hash);
});

test("MiniMax Adapter 可断点续跑、命中缓存且不落盘 API Key", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-tts-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const secret = "sk-test-secret-value-123456";
    const sourceAudio = createPcmWav(44_100, 1, 44_100);
    const normalizedAudio = createPcmWav(48_000, 1, 48_000);
    const text = "山河KinoCut重逢";
    const providerTokens = tokenizeNarration(text);
    const providerWords = timedWords(providerTokens, Math.floor(950 / providerTokens.length)).map((word) => ({
        text: word.text,
        start_ms: word.start_sample,
        end_ms: word.end_sample,
    }));
    let postCount = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
            postCount += 1;
            return Response.json({
                data: {
                    audio: "https://fixture.local/audio.wav?signature=private",
                    subtitle_file: "https://fixture.local/words.json?signature=private",
                },
                trace_id: "trace-fixture",
                base_resp: { status_code: 0, status_msg: "success" },
            });
        }
        if (url.includes("audio.wav")) return new Response(sourceAudio);
        if (url.includes("words.json")) return Response.json({ words: providerWords });
        return new Response("not found", { status: 404 });
    };

    let normalizationAttempts = 0;
    const normalizer = async (_source: string, destination: string) => {
        normalizationAttempts += 1;
        if (normalizationAttempts === 1) throw new Error("simulated interruption");
        fs.writeFileSync(destination, normalizedAudio);
        return readWavInfo(destination);
    };
    const manifest = cacheManifest(text);
    const input = {
        segment: manifest.narration_segments[0],
        profile: manifest.voice_profiles.narrator,
        mode: "draft" as const,
    };
    const firstAdapter = new MiniMaxTtsAdapter({
        cacheDirectory: directory,
        apiKey: secret,
        fetchImpl: fakeFetch,
        normalizeAudio: normalizer,
    });
    await assert.rejects(firstAdapter.synthesize(input), /simulated interruption/);
    assert.equal(postCount, 1);

    const secondAdapter = new MiniMaxTtsAdapter({
        cacheDirectory: directory,
        apiKey: secret,
        fetchImpl: fakeFetch,
        normalizeAudio: normalizer,
    });
    const resumed = await secondAdapter.synthesize(input);
    assert.equal(resumed.cacheHit, false);
    assert.equal(postCount, 1);
    const cached = await secondAdapter.synthesize(input);
    assert.equal(cached.cacheHit, true);
    assert.equal(postCount, 1);

    const cacheText = readDirectoryText(directory);
    assert.equal(cacheText.includes(secret), false);
    assert.equal(cacheText.includes("signature=private"), false);
    assert.match(cacheText, /provider_audio_hash/);
    assert.match(cacheText, /normalized_audio_hash/);
    const ttsCacheFiles = fs.readdirSync(directory, { recursive: true }).map(String);
    assert.equal(ttsCacheFiles.some((fileName) => fileName.endsWith("timestamps.resolved.json")), false);
    assert.equal(ttsCacheFiles.some((fileName) => fileName.endsWith("alignment_report.json")), false);
});

test("MiniMax POST 响应读取超时标记为 unknown_outcome 且不自动重发", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-timeout-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let postCount = 0;
    const neverEndingBody = new ReadableStream<Uint8Array>({ start() {} });
    const fakeFetch: typeof fetch = async (_input, init) => {
        if (init?.method === "POST") postCount += 1;
        return new Response(neverEndingBody, { status: 200 });
    };
    const manifest = cacheManifest("不要重复计费");
    const adapter = new MiniMaxTtsAdapter({
        cacheDirectory: directory,
        apiKey: "sk-test-secret-value-123456",
        fetchImpl: fakeFetch,
        requestTimeoutMs: 20,
        maxAttempts: 3,
    });
    await assert.rejects(adapter.synthesize({
        segment: manifest.narration_segments[0],
        profile: manifest.voice_profiles.narrator,
        mode: "draft",
    }), /请求读取超时/);
    assert.equal(postCount, 1);
    assert.match(readDirectoryText(directory), /unknown_outcome/);
});

test("FFmpeg 将 44.1 kHz 双声道重新测量为 48 kHz 单声道", async (t) => {
    const ffmpegPath = process.env.FFMPEG_PATH;
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        t.skip("未配置 FFMPEG_PATH");
        return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-ffmpeg-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "source.wav");
    const destinationPath = path.join(directory, "normalized.wav");
    fs.writeFileSync(sourcePath, createPcmWav(44_100, 2, 44_100));

    const result = await normalizeWav(sourcePath, destinationPath, { ffmpegPath });
    assert.equal(result.sampleRate, 48_000);
    assert.equal(result.channels, 1);
    assert.equal(result.sampleCount, 48_000);
});

test("Story Pipeline 端到端生成确定性的 Resolved Timeline 与执行 Receipt", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-pipeline-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const manifest = riskManifest();
    const manifestPath = path.join(directory, "story_manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const fixtureDirectory = path.join(directory, "fixture-artifacts");
    fs.mkdirSync(fixtureDirectory);
    const synthesizer: StoryTtsSynthesizer = {
        async synthesize({ segment }) {
            const words = timedWords(tokenizeNarration(segment.text), 48_000);
            const wavPath = path.join(fixtureDirectory, `${segment.id}.wav`);
            const wordsPath = path.join(fixtureDirectory, `${segment.id}.words.json`);
            fs.writeFileSync(wavPath, createPcmWav(48_000, 1, words.length * 48_000));
            fs.writeFileSync(wordsPath, JSON.stringify({ words }));
            const requestHash = canonicalJsonSha256({ segment: segment.id, text: segment.text });
            const audioHash = sha256File(wavPath);
            return {
                segmentId: segment.id,
                requestHash,
                providerAudioHash: audioHash,
                normalizedAudioHash: audioHash,
                sourceAudioPath: wavPath,
                normalizedAudioPath: wavPath,
                providerTimestampsPath: wordsPath,
                durationSamples: words.length * 48_000,
                cacheHit: false,
            };
        },
    };

    const first = await runStoryPipeline({ manifestPath, projectDirectory: directory, synthesizer });
    const firstTimeline = fs.readFileSync(first.timelinePath, "utf8");
    const second = await runStoryPipeline({ manifestPath, projectDirectory: directory, synthesizer });
    assert.equal(fs.readFileSync(second.timelinePath, "utf8"), firstTimeline);
    assert.equal(first.timeline.video_events.length, 5);
    assert.equal(first.timeline.transition_overlaps[0].duration_frames, 15);
    assert.equal(fs.existsSync(first.receiptPath), true);
    assert.match(fs.readFileSync(first.receiptPath, "utf8"), /resolved_timeline_sha256/);
});

test("Phase 1.5 Canary 只调用一次 Provider 并生成脱敏 Golden Fixture", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-canary-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const text = "山河KinoCut在2026重逢";
    const manifest = cacheManifest(text);
    const manifestPath = path.join(directory, "story_manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const secret = "sk-test-secret-value-123456";
    const tokens = tokenizeNarration(text);
    const sourceAudio = createPcmWav(44_100, 1, 44_100);
    const normalizedAudio = createPcmWav(48_000, 1, 48_000);
    const millisecondsPerToken = Math.floor(900 / tokens.length);
    const providerWords = timedWords(tokens, millisecondsPerToken).map((word) => ({
        text: word.text,
        start_ms: word.start_sample,
        end_ms: word.end_sample,
    }));
    let postCount = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
            postCount += 1;
            return Response.json({
                data: {
                    audio: "https://fixture.local/audio.wav?signature=private",
                    subtitle_file: "https://fixture.local/words.json?signature=private",
                },
                trace_id: "trace-canary",
                base_resp: { status_code: 0, status_msg: "success" },
                extra_info: { audio_length: 1_000, usage_characters: text.length },
            }, { headers: { "x-ratelimit-limit": "10", "x-ratelimit-remaining": "9" } });
        }
        if (url.includes("audio.wav")) return new Response(sourceAudio);
        if (url.includes("words.json")) return Response.json({ words: providerWords });
        return new Response("not found", { status: 404 });
    };
    const forcedAligner: ForcedAligner & ShadowAsrProbe = {
        async align() {
            return timedWords(tokens, Math.floor(48_000 / tokens.length));
        },
        async shadowAsr() {
            return shadowAsrFixture(text);
        },
    };
    const adapter = new MiniMaxTtsAdapter({
        cacheDirectory: path.join(directory, "cache", "tts"),
        apiKey: secret,
        fetchImpl: fakeFetch,
        normalizeAudio: async (_source, destination) => {
            fs.writeFileSync(destination, normalizedAudio);
            return readWavInfo(destination);
        },
    });
    const result = await runMiniMaxCanary({
        manifestPath,
        projectDirectory: directory,
        synthesizer: adapter,
        forcedAligner,
        shadowAsrProbe: forcedAligner,
        apiKey: secret,
        skipEnvironmentPreflight: true,
        now: () => new Date("2026-07-31T00:00:00.000Z"),
    });

    assert.equal(result.status, "production_acceptance_passed");
    assert.equal(postCount, 1);
    assert.equal(fs.existsSync(path.join(result.fixtureDirectory, "acceptance-report.json")), true);
    assert.equal(fs.existsSync(path.join(result.fixtureDirectory, "response.contract.json")), true);
    assert.equal(fs.existsSync(path.join(result.fixtureDirectory, "request.redacted.json")), true);
    assert.equal(fs.existsSync(path.join(result.fixtureDirectory, "provider-subtitles.json")), true);
    assert.equal(fs.existsSync(path.join(result.fixtureDirectory, "local-alignment.json")), true);
    assert.equal(fs.existsSync(path.join(result.fixtureDirectory, "alignment-comparison.json")), true);
    assert.equal(fs.existsSync(path.join(result.fixtureDirectory, "audio-manifest.json")), true);
    assert.equal(
        fs.readdirSync(result.fixtureDirectory, { recursive: true })
            .map(String)
            .some((fileName) => path.extname(fileName).toLowerCase() === ".wav"),
        false,
    );
    const fixtureText = readDirectoryText(result.fixtureDirectory);
    assert.equal(fixtureText.includes(secret), false);
    assert.equal(fixtureText.includes("signature=private"), false);
    assert.equal(fixtureText.includes("fixture-voice"), false);
    assert.match(fixtureText, /x-ratelimit-limit/);
});

test("Production Canary 先跑 Turbo，再跑 HD，第二轮 HD 不重复请求", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-production-canary-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const text = "重庆夜车的KinoCut在2026重逢";
    const smokeManifestPath = path.join(directory, "smoke.json");
    const hdManifestPath = path.join(directory, "hd.json");
    fs.writeFileSync(smokeManifestPath, JSON.stringify(cacheManifest(text)));
    fs.writeFileSync(hdManifestPath, JSON.stringify(cacheManifest(text)));
    const tokens = tokenizeNarration(text);
    const providerWords = timedWords(tokens, Math.floor(900 / tokens.length)).map((word) => ({
        text: word.text,
        start_ms: word.start_sample,
        end_ms: word.end_sample,
    }));
    const sourceAudio = createPcmWav(44_100, 1, 44_100);
    const normalizedAudio = createPcmWav(48_000, 1, 48_000);
    const requestedModels: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as { model: string };
            requestedModels.push(body.model);
            return Response.json({
                data: {
                    audio: `https://fixture.local/audio.wav?model=${body.model}&signature=private`,
                    subtitle_file: `https://fixture.local/words.json?model=${body.model}&signature=private`,
                },
                trace_id: `trace-${body.model}`,
                base_resp: { status_code: 0, status_msg: "success" },
                extra_info: { audio_length: 1_000, usage_characters: text.length },
            });
        }
        if (url.includes("audio.wav")) return new Response(sourceAudio);
        if (url.includes("words.json")) return Response.json({ words: providerWords });
        return new Response("not found", { status: 404 });
    };
    const makeAdapter = (cacheDirectory: string) => new MiniMaxTtsAdapter({
        cacheDirectory,
        apiKey: "sk-test-secret-value-123456",
        fetchImpl: fakeFetch,
        normalizeAudio: async (_source, destination) => {
            fs.writeFileSync(destination, normalizedAudio);
            return readWavInfo(destination);
        },
    });
    const aligner: ForcedAligner & ShadowAsrProbe = {
        async align() {
            return timedWords(tokens, Math.floor(48_000 / tokens.length));
        },
        async shadowAsr() {
            return shadowAsrFixture(text);
        },
    };
    const result = await runMiniMaxProductionCanary({
        smokeManifestPath,
        hdManifestPath,
        projectDirectory: path.join(directory, "run"),
        smokeSynthesizer: makeAdapter(path.join(directory, "smoke-cache")),
        hdSynthesizer: makeAdapter(path.join(directory, "hd-cache")),
        forcedAligner: aligner,
        shadowAsrProbe: aligner,
        apiKey: "sk-test-secret-value-123456",
        skipEnvironmentPreflight: true,
        now: () => new Date("2026-07-31T01:00:00.000Z"),
    });

    assert.equal(result.status, "production_acceptance_passed");
    assert.deepEqual(requestedModels, ["speech-2.8-turbo", "speech-2.8-hd"]);
    assert.equal(result.smoke.status, "turbo_smoke_passed");
    assert.equal(fs.existsSync(result.reportPath), true);
    assert.match(result.hd.fixtureDirectory.replace(/\\/g, "/"), /fixtures\/minimax-production-canary/);
});

test("Turbo 烟雾测试失败时不会启动 HD Canary", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-canvas-smoke-gate-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const manifest = cacheManifest("烟雾测试失败后立即停止");
    const smokeManifestPath = path.join(directory, "smoke.json");
    const hdManifestPath = path.join(directory, "hd.json");
    fs.writeFileSync(smokeManifestPath, JSON.stringify(manifest));
    fs.writeFileSync(hdManifestPath, JSON.stringify(manifest));
    let hdCalls = 0;
    const smokeSynthesizer: StoryTtsSynthesizer = {
        async synthesize() {
            throw new Error("simulated turbo failure");
        },
    };
    const hdSynthesizer: StoryTtsSynthesizer = {
        async synthesize() {
            hdCalls += 1;
            throw new Error("HD must not run");
        },
    };
    await assert.rejects(runMiniMaxProductionCanary({
        smokeManifestPath,
        hdManifestPath,
        projectDirectory: path.join(directory, "run"),
        smokeSynthesizer,
        hdSynthesizer,
        skipEnvironmentPreflight: true,
    }), /simulated turbo failure/);
    assert.equal(hdCalls, 0);
});

function riskManifest(): StoryManifest {
    return StoryManifestSchema.parse({
        schema_version: "1.0",
        tokenizer_version: STORY_TOKENIZER_VERSION,
        project_id: "risk-fixture",
        output: { fps_num: 30, fps_den: 1 },
        voice_profiles: {
            narrator: {
                provider: "minimax",
                draft_model: "speech-2.8-turbo",
                final_model: "speech-2.8-hd",
                voice_id: "fixture-voice",
                speed: 1,
                vol: 1,
                pitch: 0,
                emotion: null,
                language_boost: "Chinese",
            },
        },
        narration_segments: [
            { id: "VO001", speaker_id: "narrator", text: "甲乙丙丁戊", delivery: { target_pace: "medium", pause_after_ms: 0 } },
            { id: "VO002", speaker_id: "narrator", text: "己庚辛壬癸", delivery: { target_pace: "slow", emotion: "sad", pause_after_ms: 0 } },
        ],
        assets: ["IMG001", "IMG002", "IMG003", "IMG004", "IMG005"].map((id) => ({ id, type: "image" })),
        shots: [
            shot("S001", "IMG001", [{ segment_id: "VO001", range: { from_token: 0, to_token: 2 } }]),
            shot("S002", "IMG002", [{ segment_id: "VO001", range: { from_token: 1, to_token: 4 } }]),
            shot("S003", "IMG003", [
                { segment_id: "VO001", range: { from_token: 4, to_token: 5 } },
                { segment_id: "VO002", range: { from_token: 0, to_token: 1 } },
            ], { type: "dissolve", duration_frames: 15 }),
            shot("S004", "IMG004", [{ segment_id: "VO002", range: { from_token: 1, to_token: 3 } }]),
            shot("S005", "IMG005", [{ segment_id: "VO002", range: { from_token: 3, to_token: 5 } }]),
        ],
    });
}

function cacheManifest(text: string): StoryManifest {
    return StoryManifestSchema.parse({
        schema_version: "1.0",
        project_id: "cache-fixture",
        voice_profiles: {
            narrator: {
                provider: "minimax",
                voice_id: "fixture-voice",
            },
        },
        narration_segments: [{ id: "VO001", speaker_id: "narrator", text }],
        shots: [{
            id: "S001",
            image_asset_id: "IMG001",
            narration_refs: [{ segment_id: "VO001", range: { from_token: 0, to_token: tokenizeNarration(text).length } }],
        }],
    });
}

function shot(
    id: string,
    imageAssetId: string,
    narrationRefs: StoryManifest["shots"][number]["narration_refs"],
    transition = { type: "cut" as const, duration_frames: 0 },
) {
    return {
        id,
        image_asset_id: imageAssetId,
        narration_refs: narrationRefs,
        transition_out: transition,
    };
}

function resolverArtifacts(vo2Hash: string): ResolvedNarrationArtifact[] {
    return [
        {
            segmentId: "VO001",
            requestHash: HASH_A,
            providerAudioHash: HASH_A,
            normalizedAudioHash: HASH_A,
            alignmentHash: HASH_A,
            audioPath: "build/story-pipeline/audio/VO001.wav",
            timestampsPath: "build/story-pipeline/audio/VO001.words.json",
            durationSamples: 5 * 48_000,
            words: timedWords(["甲", "乙", "丙", "丁", "戊"], 48_000),
            alignmentSource: "minimax_word",
            fallbackUsed: false,
            validationScore: 1,
        },
        {
            segmentId: "VO002",
            requestHash: vo2Hash,
            providerAudioHash: vo2Hash,
            normalizedAudioHash: vo2Hash,
            alignmentHash: vo2Hash,
            audioPath: "build/story-pipeline/audio/VO002.wav",
            timestampsPath: "build/story-pipeline/audio/VO002.words.json",
            durationSamples: 5 * 48_000,
            words: timedWords(["己", "庚", "辛", "壬", "癸"], 48_000),
            alignmentSource: "local_forced_alignment",
            fallbackUsed: true,
            validationScore: 1,
        },
    ];
}

function timedWords(tokens: string[], samplesPerToken: number): WordTimestamp[] {
    return tokens.map((text, index) => ({
        index,
        text,
        start_sample: index * samplesPerToken,
        end_sample: (index + 1) * samplesPerToken,
    }));
}

function shadowAsrFixture(text: string) {
    return {
        schema_version: "1",
        backend: {
            name: "faster-whisper",
            model: "small",
            device: "cuda",
            compute_type: "int8_float16",
        },
        language: "zh",
        language_probability: 1,
        recognized_text: text,
        text_similarity: 1,
        segments: [],
        diagnostic_only: true as const,
    };
}

function createPcmWav(sampleRate: number, channels: number, sampleCount: number) {
    const bitsPerSample = 16;
    const blockAlign = channels * bitsPerSample / 8;
    const dataSize = sampleCount * blockAlign;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * blockAlign, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write("data", 36, "ascii");
    buffer.writeUInt32LE(dataSize, 40);
    return buffer;
}

function readDirectoryText(directory: string) {
    return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const filePath = path.join(entry.parentPath, entry.name);
            return path.extname(filePath) === ".wav" ? "" : fs.readFileSync(filePath, "utf8");
        })
        .join("\n");
}
