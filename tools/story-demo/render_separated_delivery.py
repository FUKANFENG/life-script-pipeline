from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import wave
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from render_story_demo import (
    FPS,
    HEIGHT,
    SAMPLE_RATE,
    WIDTH,
    build_subtitles,
    choose_encoder,
    compose_narration_audio,
    encoder_args,
    ffprobe_media,
    fit_wav_samples,
    measured_frame_count,
    media_video_stream,
    read_json,
    render_shot,
    run_command,
    sha256_file,
    write_json,
)


SOFT_TRANSITION_FRAMES = 4
SHOTS_ROOT_NAME = "shots-v2"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def link_or_copy(source: Path, target: Path) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
    try:
        os.link(source, target)
        return "hardlink"
    except OSError:
        shutil.copy2(source, target)
        return "copy"


def build_transition_plan(
    *,
    manifest: dict[str, Any],
    timeline: dict[str, Any],
    soft_transition_frames: int,
) -> dict[str, Any]:
    event_by_id = {event["shot_id"]: event for event in timeline["video_events"]}
    chapter_overlap_by_from = {
        overlap["from_shot_id"]: overlap
        for overlap in timeline["transition_overlaps"]
    }
    shots = manifest["shots"]
    records: list[dict[str, Any]] = []
    render_event_by_id: dict[str, dict[str, Any]] = {}

    for index, shot in enumerate(shots):
        shot_id = shot["id"]
        event = dict(event_by_id[shot_id])
        original_frames = int(event["duration_frames"])
        is_last = index == len(shots) - 1
        chapter_overlap = chapter_overlap_by_from.get(shot_id)
        if chapter_overlap:
            transition_type = "chapter_dissolve"
            transition_frames = int(chapter_overlap["duration_frames"])
            extension_frames = 0
        elif not is_last:
            transition_type = "soft_dissolve"
            transition_frames = soft_transition_frames
            extension_frames = soft_transition_frames
        else:
            transition_type = "none"
            transition_frames = 0
            extension_frames = 0

        render_frames = original_frames + extension_frames
        event["duration_frames"] = render_frames
        event["duration_seconds"] = render_frames / FPS
        render_event_by_id[shot_id] = event
        records.append(
            {
                "shot_id": shot_id,
                "timeline_start_frame": int(event_by_id[shot_id]["start_frame"]),
                "original_duration_frames": original_frames,
                "render_duration_frames": render_frames,
                "extension_frames": extension_frames,
                "transition_out": {
                    "type": transition_type,
                    "duration_frames": transition_frames,
                },
            }
        )

    expected_frames = (
        sum(item["render_duration_frames"] for item in records)
        - sum(
            item["transition_out"]["duration_frames"]
            for item in records
        )
    )
    timeline_frames = int(timeline["totals"]["playback_frames"])
    if expected_frames != timeline_frames:
        raise RuntimeError(
            "Separated transition plan changed the timeline length: "
            f"expected {timeline_frames}, got {expected_frames}"
        )

    return {
        "schema_version": "1",
        "renderer_version": "story-demo-motion-v2",
        "soft_transition_frames": soft_transition_frames,
        "soft_transition_seconds": soft_transition_frames / FPS,
        "expected_playback_frames": expected_frames,
        "shots": records,
        "render_event_by_id": render_event_by_id,
    }


def render_v2_shots(
    *,
    demo_root: Path,
    ffmpeg: Path,
    ffprobe: Path,
    manifest: dict[str, Any],
    transition_plan: dict[str, Any],
    workers: int,
    force: bool,
) -> dict[str, Any]:
    probe_dir = demo_root / "build" / "renderer-probe-v2"
    probe_dir.mkdir(parents=True, exist_ok=True)
    first_image = demo_root / "images" / "16x9" / "S001.png"
    encoder = choose_encoder(ffmpeg, first_image, probe_dir)
    event_by_id = transition_plan["render_event_by_id"]

    results: list[dict[str, Any]] = []
    started_at = utc_now()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [
            pool.submit(
                render_shot,
                demo_root=demo_root,
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                encoder=encoder,
                shot=shot,
                event=event_by_id[shot["id"]],
                force=force,
                shots_root_name=SHOTS_ROOT_NAME,
            )
            for shot in manifest["shots"]
        ]
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())

    results.sort(key=lambda item: item["shot_id"])
    summary = {
        "schema_version": "1",
        "started_at": started_at,
        "finished_at": utc_now(),
        "renderer": "ffmpeg-zoompan-v2",
        "encoder": encoder,
        "workers": workers,
        "shots_root": SHOTS_ROOT_NAME,
        "shot_count": len(results),
        "rendered": sum(item["status"] == "rendered" for item in results),
        "cache_hits": sum(item["status"] == "cache_hit" for item in results),
        "results": results,
    }
    write_json(demo_root / "shot-render-summary.v2.json", summary)
    return summary


def build_separated_assembly_spec(
    *,
    demo_root: Path,
    manifest: dict[str, Any],
    timeline: dict[str, Any],
    soft_transition_frames: int,
) -> tuple[Path, dict[str, Any]]:
    shot_ids = [shot["id"] for shot in manifest["shots"]]
    chapter_ends = {
        overlap["from_shot_id"] for overlap in timeline["transition_overlaps"]
    }
    chunks: list[list[str]] = []
    current: list[str] = []
    for shot_id in shot_ids:
        current.append(shot_id)
        if shot_id in chapter_ends:
            chunks.append(current)
            current = []
    if current:
        chunks.append(current)

    sources = {
        shot_id.lower(): {
            "path": f"{SHOTS_ROOT_NAME}/{shot_id}/final.mp4"
        }
        for shot_id in shot_ids
    }
    steps: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks, start=1):
        steps.append(
            {
                "id": f"soft_merge_chunk_{index:02d}",
                "op": "merge",
                "inputs": {
                    "srcs": [
                        f"@sources.{shot_id.lower()}" for shot_id in chunk
                    ]
                },
                "params": {
                    "transitions": ["dissolve"] * (len(chunk) - 1),
                    "transition_duration": soft_transition_frames / FPS,
                },
                "output": f"@work/soft_chunk_{index:02d}.mp4",
            }
        )

    chunk_refs = [
        f"@work/soft_chunk_{index:02d}.mp4"
        for index in range(1, len(chunks) + 1)
    ]
    steps.append(
        {
            "id": "merge_chapters_with_dissolves",
            "op": "merge",
            "inputs": {"srcs": chunk_refs},
            "params": {
                "transitions": ["dissolve"] * (len(chunks) - 1),
                "transition_duration": 0.4,
            },
            "output": "@outputs.picture_lock",
        }
    )

    spec = {
        "schema_version": 1,
        "name": f"{manifest['project_id']}-separated-picture-lock-v2",
        "sources": sources,
        "steps": steps,
        "outputs": {
            "picture_lock": {
                "path": "assemblies/separated/picture-lock.kinocut.mp4"
            }
        },
        "variants": [],
    }
    spec_path = demo_root / "assembly_job.separated.json"
    write_json(spec_path, spec)
    write_json(
        demo_root / "assembly-chunks.separated.json",
        {
            "schema_version": "1",
            "soft_transition_frames": soft_transition_frames,
            "chapter_transition_frames": 12,
            "chunks": [
                {"id": f"chunk_{index:02d}", "shots": chunk}
                for index, chunk in enumerate(chunks, start=1)
            ],
        },
    )
    return spec_path, spec


def run_separated_kinocut(
    *,
    demo_root: Path,
    kino: Path,
    spec_path: Path,
    force: bool,
) -> dict[str, Any]:
    build_dir = demo_root / "build" / "kinocut-separated"
    logs_dir = demo_root / "logs"
    output_path = (
        demo_root / "assemblies" / "separated" / "picture-lock.kinocut.mp4"
    )
    plan_path = build_dir / "workflow-plan.json"
    receipt_path = build_dir / "workflow-receipt.json"
    inspect_path = build_dir / "workflow-inspection.json"
    build_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if force:
        output_path.unlink(missing_ok=True)
        receipt_path.unlink(missing_ok=True)
        plan_path.unlink(missing_ok=True)
        inspect_path.unlink(missing_ok=True)

    run_command(
        [str(kino), "--format", "json", "workflow-validate", "--spec", str(spec_path)],
        cwd=demo_root,
        log_path=logs_dir / "kinocut-separated-validate.log",
    )
    run_command(
        [
            str(kino),
            "--format",
            "json",
            "workflow-plan",
            "--spec",
            str(spec_path),
            "--save-plan",
            str(plan_path),
        ],
        cwd=demo_root,
        log_path=logs_dir / "kinocut-separated-plan.log",
    )
    if not output_path.is_file():
        run_command(
            [
                str(kino),
                "--format",
                "json",
                "workflow-render",
                "--spec",
                str(spec_path),
                "--save-receipt",
                str(receipt_path),
                "--keep-intermediates",
            ],
            cwd=demo_root,
            log_path=logs_dir / "kinocut-separated-render.log",
        )
    inspect = run_command(
        [
            str(kino),
            "--format",
            "json",
            "workflow-inspect",
            "--receipt",
            str(receipt_path),
        ],
        cwd=demo_root,
        log_path=logs_dir / "kinocut-separated-inspect.log",
    )
    try:
        inspection_payload: Any = json.loads(inspect.stdout)
    except json.JSONDecodeError:
        inspection_payload = {"raw": inspect.stdout.strip()}
    write_json(inspect_path, inspection_payload)
    if not output_path.is_file():
        raise FileNotFoundError(output_path)
    return {
        "output_path": str(output_path),
        "output_sha256": sha256_file(output_path),
        "plan_path": str(plan_path),
        "receipt_path": str(receipt_path),
        "inspection_path": str(inspect_path),
    }


def build_video_only(
    *,
    demo_root: Path,
    ffmpeg: Path,
    ffprobe: Path,
    source_path: Path,
    target_frames: int,
) -> dict[str, Any]:
    output_path = demo_root / "assemblies" / "separated" / "video-only.mp4"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    source_probe = ffprobe_media(ffprobe, source_path)
    source_frames = measured_frame_count(source_probe)
    if source_frames < target_frames:
        raise RuntimeError(
            f"Kinocut picture lock is too short: {source_frames}<{target_frames}"
        )

    encoder = choose_encoder(
        ffmpeg,
        demo_root / "images" / "16x9" / "S001.png",
        demo_root / "build" / "renderer-probe-v2",
    )
    temp_path = output_path.with_name("video-only.rendering.mp4")
    temp_path.unlink(missing_ok=True)
    run_command(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            (
                f"fps={FPS},trim=end_frame={target_frames},"
                f"setpts=N/({FPS}*TB),format=yuv420p"
            ),
            "-frames:v",
            str(target_frames),
            *encoder_args(encoder),
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "cfr",
            "-movflags",
            "+faststart",
            str(temp_path),
        ],
        log_path=demo_root / "logs" / "separated-video-normalize.log",
    )
    temp_path.replace(output_path)

    probe = ffprobe_media(ffprobe, output_path)
    video_streams = [
        stream for stream in probe["streams"]
        if stream.get("codec_type") == "video"
    ]
    audio_streams = [
        stream for stream in probe["streams"]
        if stream.get("codec_type") == "audio"
    ]
    subtitle_streams = [
        stream for stream in probe["streams"]
        if stream.get("codec_type") == "subtitle"
    ]
    frames = measured_frame_count(probe)
    video = media_video_stream(probe)
    checks = {
        "one_video_stream": len(video_streams) == 1,
        "no_audio_stream": not audio_streams,
        "no_subtitle_stream": not subtitle_streams,
        "exact_frame_count": frames == target_frames,
        "resolution_1920x1080": (
            int(video["width"]) == WIDTH and int(video["height"]) == HEIGHT
        ),
        "frame_rate_30": video.get("avg_frame_rate") == "30/1",
        "h264_yuv420p": (
            video.get("codec_name") == "h264"
            and video.get("pix_fmt") == "yuv420p"
        ),
    }
    if not all(checks.values()):
        raise RuntimeError(f"Video-only contract failed: {checks}")
    return {
        "path": str(output_path),
        "sha256": sha256_file(output_path),
        "size_bytes": output_path.stat().st_size,
        "frames": frames,
        "duration_seconds": frames / FPS,
        "probe": probe,
        "checks": checks,
    }


def prepare_voiceover(
    *,
    demo_root: Path,
    ffmpeg: Path,
    timeline: dict[str, Any],
) -> dict[str, Any]:
    target_samples = int(timeline["totals"]["playback_samples"])
    source_path = (
        demo_root / "audio" / "narration-normalized.-16lufs.48000.mono.wav"
    )
    if not source_path.is_file():
        raw_path = demo_root / "audio" / "narration-timeline.48000.mono.wav"
        run_command(
            [
                str(ffmpeg),
                "-hide_banner",
                "-loglevel",
                "warning",
                "-y",
                "-i",
                str(raw_path),
                "-af",
                (
                    "loudnorm=I=-16:TP=-2.0:LRA=11,"
                    f"aresample={SAMPLE_RATE},"
                    "alimiter=limit=0.78:attack=5:release=50:level=disabled,"
                    f"apad=whole_len={target_samples},"
                    f"atrim=end_sample={target_samples},"
                    "asetpts=N/SR/TB"
                ),
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(source_path),
            ],
            log_path=demo_root / "logs" / "separated-voiceover-normalize.log",
        )
    fit_wav_samples(source_path, target_samples)

    output_path = (
        demo_root
        / "assemblies"
        / "separated"
        / "narration-48k-mono.wav"
    )
    materialization = link_or_copy(source_path, output_path)
    with wave.open(str(output_path), "rb") as stream:
        channels = stream.getnchannels()
        sample_rate = stream.getframerate()
        sample_width = stream.getsampwidth()
        samples = stream.getnframes()
    checks = {
        "mono": channels == 1,
        "sample_rate_48000": sample_rate == SAMPLE_RATE,
        "pcm_s16": sample_width == 2,
        "exact_sample_count": samples == target_samples,
    }
    if not all(checks.values()):
        raise RuntimeError(f"Voiceover contract failed: {checks}")
    return {
        "path": str(output_path),
        "sha256": sha256_file(output_path),
        "size_bytes": output_path.stat().st_size,
        "samples": samples,
        "sample_rate": sample_rate,
        "duration_seconds": samples / sample_rate,
        "materialization": materialization,
        "checks": checks,
    }


def parse_srt_time(value: str) -> float:
    hours, minutes, remainder = value.split(":")
    seconds, milliseconds = remainder.split(",")
    return (
        int(hours) * 3600
        + int(minutes) * 60
        + int(seconds)
        + int(milliseconds) / 1000
    )


def prepare_subtitles(
    *,
    demo_root: Path,
    target_duration_seconds: float,
) -> dict[str, Any]:
    source_path = demo_root / "subtitles" / "zh-CN.srt"
    output_path = (
        demo_root
        / "assemblies"
        / "separated"
        / "subtitles-zh-CN.srt"
    )
    materialization = link_or_copy(source_path, output_path)
    text = output_path.read_text(encoding="utf-8-sig")
    matches = re.findall(
        r"(\d{2}:\d{2}:\d{2},\d{3}) --> "
        r"(\d{2}:\d{2}:\d{2},\d{3})",
        text,
    )
    if not matches:
        raise RuntimeError("No timecoded cues found in SRT")
    ranges = [
        (parse_srt_time(start), parse_srt_time(end))
        for start, end in matches
    ]
    monotonic = all(
        start >= 0
        and end > start
        and (index == 0 or start >= ranges[index - 1][1] - 0.001)
        for index, (start, end) in enumerate(ranges)
    )
    checks = {
        "has_timecodes": bool(ranges),
        "monotonic_non_overlapping": monotonic,
        "within_video_duration": ranges[-1][1]
        <= target_duration_seconds + 0.001,
    }
    if not all(checks.values()):
        raise RuntimeError(f"Subtitle contract failed: {checks}")
    return {
        "path": str(output_path),
        "sha256": sha256_file(output_path),
        "size_bytes": output_path.stat().st_size,
        "cue_count": len(ranges),
        "first_start_seconds": ranges[0][0],
        "last_end_seconds": ranges[-1][1],
        "materialization": materialization,
        "checks": checks,
    }


def package_three_tracks(
    *,
    demo_root: Path,
    manifest: dict[str, Any],
    video: dict[str, Any],
    audio: dict[str, Any],
    subtitles: dict[str, Any],
) -> dict[str, Any]:
    track_dir = demo_root / "delivery" / "separated-tracks"
    track_dir.mkdir(parents=True, exist_ok=True)
    records = []
    sources = [
        (Path(video["path"]), "01-video-only.mp4", "video"),
        (Path(audio["path"]), "02-narration-48k-mono.wav", "audio"),
        (Path(subtitles["path"]), "03-subtitles-zh-CN.srt", "subtitles"),
    ]
    for source, filename, role in sources:
        target = track_dir / filename
        mode = link_or_copy(source, target)
        records.append(
            {
                "role": role,
                "path": str(target),
                "filename": filename,
                "size_bytes": target.stat().st_size,
                "sha256": sha256_file(target),
                "materialization": mode,
            }
        )

    zip_path = (
        demo_root
        / "delivery"
        / f"{manifest['project_id']}-separated-tracks.zip"
    )
    zip_path.unlink(missing_ok=True)
    with zipfile.ZipFile(zip_path, "w", allowZip64=True) as archive:
        for record in records:
            path = Path(record["path"])
            compression = (
                zipfile.ZIP_STORED
                if path.suffix.lower() in {".mp4", ".wav"}
                else zipfile.ZIP_DEFLATED
            )
            archive.write(
                path,
                record["filename"],
                compress_type=compression,
            )
    with zipfile.ZipFile(zip_path) as archive:
        zip_error = archive.testzip()
        zip_entries = archive.namelist()
    if zip_error or zip_entries != [record["filename"] for record in records]:
        raise RuntimeError(
            f"Three-track package verification failed: {zip_error}, {zip_entries}"
        )

    return {
        "schema_version": "1",
        "project_id": manifest["project_id"],
        "title": manifest["title"],
        "created_at": utc_now(),
        "delivery_contract": "separate_video_voiceover_timecoded_srt",
        "track_directory": str(track_dir),
        "tracks": records,
        "package": {
            "path": str(zip_path),
            "size_bytes": zip_path.stat().st_size,
            "sha256": sha256_file(zip_path),
            "entry_count": len(zip_entries),
            "entries": zip_entries,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Render a smooth picture lock and deliver video, voiceover, "
            "and timecoded SRT as three separate synchronized tracks."
        )
    )
    parser.add_argument("--demo-root", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--ffprobe", required=True, type=Path)
    parser.add_argument("--kino", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--force-shots", action="store_true")
    parser.add_argument("--force-assembly", action="store_true")
    args = parser.parse_args()

    demo_root = args.demo_root.resolve()
    ffmpeg = args.ffmpeg.resolve()
    ffprobe = args.ffprobe.resolve()
    kino = args.kino.resolve()
    for path in (demo_root, ffmpeg, ffprobe, kino):
        if not path.exists():
            raise FileNotFoundError(path)
    os.environ["PATH"] = str(ffmpeg.parent) + os.pathsep + os.environ.get("PATH", "")

    manifest = read_json(demo_root / "story_manifest.json")
    timeline = read_json(demo_root / "resolved_timeline.json")
    transition_plan = build_transition_plan(
        manifest=manifest,
        timeline=timeline,
        soft_transition_frames=SOFT_TRANSITION_FRAMES,
    )
    write_json(
        demo_root / "separated-transition-plan.json",
        {
            key: value
            for key, value in transition_plan.items()
            if key != "render_event_by_id"
        },
    )

    subtitles_manifest = build_subtitles(
        demo_root=demo_root,
        manifest=manifest,
        timeline=timeline,
    )
    compose_narration_audio(demo_root=demo_root, timeline=timeline)
    shot_summary = render_v2_shots(
        demo_root=demo_root,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        manifest=manifest,
        transition_plan=transition_plan,
        workers=args.workers,
        force=args.force_shots,
    )
    spec_path, _ = build_separated_assembly_spec(
        demo_root=demo_root,
        manifest=manifest,
        timeline=timeline,
        soft_transition_frames=SOFT_TRANSITION_FRAMES,
    )
    kinocut = run_separated_kinocut(
        demo_root=demo_root,
        kino=kino,
        spec_path=spec_path,
        force=args.force_assembly,
    )
    target_frames = int(timeline["totals"]["playback_frames"])
    video = build_video_only(
        demo_root=demo_root,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        source_path=Path(kinocut["output_path"]),
        target_frames=target_frames,
    )
    audio = prepare_voiceover(
        demo_root=demo_root,
        ffmpeg=ffmpeg,
        timeline=timeline,
    )
    subtitles = prepare_subtitles(
        demo_root=demo_root,
        target_duration_seconds=video["duration_seconds"],
    )

    duration_delta_audio = abs(
        video["duration_seconds"] - audio["duration_seconds"]
    )
    timeline_checks = {
        "video_audio_duration_match": duration_delta_audio
        <= 1 / SAMPLE_RATE,
        "subtitle_within_timeline": subtitles["last_end_seconds"]
        <= video["duration_seconds"] + 0.001,
        "video_has_no_audio_or_subtitle": (
            video["checks"]["no_audio_stream"]
            and video["checks"]["no_subtitle_stream"]
        ),
    }
    if not all(timeline_checks.values()):
        raise RuntimeError(f"Separated timeline contract failed: {timeline_checks}")

    package = package_three_tracks(
        demo_root=demo_root,
        manifest=manifest,
        video=video,
        audio=audio,
        subtitles=subtitles,
    )
    quality = {
        "schema_version": "1",
        "status": "pass",
        "created_at": utc_now(),
        "transition_policy": {
            "ordinary_boundaries": (
                f"{SOFT_TRANSITION_FRAMES}-frame dissolve with outgoing "
                "shot extension; timeline length unchanged"
            ),
            "chapter_boundaries": "12-frame dissolve",
            "motion": (
                "4x internal supersampling, smoothstep easing, reduced range, "
                "single-image zoompan generation"
            ),
        },
        "video": video,
        "audio": audio,
        "subtitles": subtitles,
        "timeline_checks": timeline_checks,
        "kinocut": kinocut,
        "shot_summary": {
            "shot_count": shot_summary["shot_count"],
            "rendered": shot_summary["rendered"],
            "cache_hits": shot_summary["cache_hits"],
        },
        "subtitle_source": subtitles_manifest["source_alignment"],
        "package": package,
    }
    write_json(demo_root / "qc" / "separated-tracks-quality.json", quality)
    write_json(demo_root / "separated-delivery-manifest.json", package)
    print(
        json.dumps(
            {
                "status": "pass",
                "video": {
                    key: video[key]
                    for key in (
                        "path",
                        "sha256",
                        "size_bytes",
                        "frames",
                        "duration_seconds",
                    )
                },
                "audio": {
                    key: audio[key]
                    for key in (
                        "path",
                        "sha256",
                        "size_bytes",
                        "samples",
                        "duration_seconds",
                    )
                },
                "subtitles": {
                    key: subtitles[key]
                    for key in (
                        "path",
                        "sha256",
                        "size_bytes",
                        "cue_count",
                        "last_end_seconds",
                    )
                },
                "package": package["package"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
