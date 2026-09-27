import path from "node:path";

import {
  inspectProductionCanaryPreflight,
  runMiniMaxProductionCanary,
} from "./canary.js";
import { readJsonFile } from "./io.js";
import { runStoryPipeline } from "./pipeline.js";
import { StoryManifestSchema } from "./schemas.js";

export async function runStoryCli(args: string[]) {
  const command = args[0];
  const manifestPath = args[1];
  if (
    !command ||
    !manifestPath ||
    !["validate", "resolve", "canary-preflight", "canary"].includes(command)
  ) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (command === "validate") {
    const manifest = StoryManifestSchema.parse(
      readJsonFile<unknown>(path.resolve(manifestPath)),
    );
    process.stdout.write(
      `Story Manifest 有效：${manifest.project_id}，${manifest.narration_segments.length} 段旁白，${manifest.shots.length} 个镜头\n`,
    );
    return;
  }

  const flags = parseFlags(args.slice(2));
  const smokeManifestPath =
    flags.smoke ||
    path.join(
      path.dirname(path.resolve(manifestPath)),
      "phase-1.5-turbo-smoke-manifest.json",
    );
  if (command === "canary-preflight") {
    const report = inspectProductionCanaryPreflight({
      smokeManifestPath,
      hdManifestPath: manifestPath,
      projectDirectory:
        flags.project || path.dirname(path.resolve(manifestPath)),
      ffmpegPath: flags.ffmpeg || process.env.FFMPEG_PATH,
      alignerExecutable: flags.aligner || process.env.STORY_ALIGNER_EXECUTABLE,
    });
    for (const [stage, stageReport] of [
      ["Turbo", report.smoke],
      ["HD", report.hd],
    ] as const) {
      for (const check of stageReport.checks) {
        process.stdout.write(
          `${check.passed ? "PASS" : "FAIL"} [${stage}] ${check.id}: ${check.detail}\n`,
        );
      }
    }
    if (!report.ready) process.exitCode = 2;
    return;
  }
  if (command === "canary") {
    const result = await runMiniMaxProductionCanary({
      smokeManifestPath,
      hdManifestPath: manifestPath,
      projectDirectory:
        flags.project || path.dirname(path.resolve(manifestPath)),
      ffmpegPath: flags.ffmpeg || process.env.FFMPEG_PATH,
      alignerExecutable: flags.aligner || process.env.STORY_ALIGNER_EXECUTABLE,
    });
    process.stdout.write(
      `Turbo Smoke：${result.smoke.status}\n` +
        `Phase 1.5 状态：${result.status}\n` +
        `Golden Fixture：${result.hd.fixtureDirectory}\n`,
    );
    if (result.status !== "production_acceptance_passed") process.exitCode = 3;
    return;
  }
  const result = await runStoryPipeline({
    manifestPath,
    projectDirectory: flags.project || path.dirname(path.resolve(manifestPath)),
    mode: flags.mode === "final" ? "final" : "draft",
    forceSegments: flags.force
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    forceAlignmentSegments: flags["force-alignment"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ffmpegPath: flags.ffmpeg || process.env.FFMPEG_PATH,
    alignerExecutable: flags.aligner || process.env.STORY_ALIGNER_EXECUTABLE,
    alignmentMaxConcurrency: flags["alignment-concurrency"]
      ? Number(flags["alignment-concurrency"])
      : undefined,
  });
  const ttsCacheHits = result.artifacts.filter(
    (artifact) => artifact.ttsCacheHit,
  ).length;
  const alignmentCacheHits = result.artifacts.filter(
    (artifact) => artifact.alignmentCacheHit,
  ).length;
  process.stdout.write(
    `时间线已生成：${result.timelinePath}\n` +
      `TTS 缓存命中：${ttsCacheHits}/${result.artifacts.length}\n` +
      `Alignment 缓存命中：${alignmentCacheHits}/${result.artifacts.length}\n` +
      `播放长度：${result.timeline.totals.playback_frames} 帧\n`,
  );
}

function parseFlags(args: string[]) {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) throw new Error(`无法识别参数：${current}`);
    const key = current.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`参数 --${key} 缺少值`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

function printUsage() {
  process.stdout.write(
    "用法：\n" +
      "  canvas-agent story validate <story_manifest.json>\n" +
      "  canvas-agent story resolve <story_manifest.json> --project <目录> [--mode draft|final]\n" +
      "    [--ffmpeg <ffmpeg.exe>] [--aligner <本地对齐包装程序>]\n" +
      "    [--alignment-concurrency <正整数，默认 1>]\n" +
      "    [--force VO002,VO003] [--force-alignment VO002,VO003]\n" +
      "  canvas-agent story canary-preflight <hd_manifest.json> --project <目录> --ffmpeg <ffmpeg.exe> --aligner <对齐器>\n" +
      "    [--smoke <turbo_smoke_manifest.json>]\n" +
      "  canvas-agent story canary <hd_manifest.json> --project <目录> --ffmpeg <ffmpeg.exe> --aligner <对齐器>\n" +
      "    [--smoke <turbo_smoke_manifest.json>]\n",
  );
}
