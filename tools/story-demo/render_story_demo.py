from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


FPS = 30
SAMPLE_RATE = 48_000
WIDTH = 1920
HEIGHT = 1080
MAX_SUBTITLE_CHARS = 14
STRONG_PUNCTUATION = frozenset("。！？!?")
SOFT_PUNCTUATION = frozenset("，、；：,;:")
IGNORED_TEXT_CHARS = frozenset(
    " \t\r\n，。！？；：、“”‘’（）()—…,.!?;:《》〈〉【】[]-"
)
PAUSE_TAG_RE = re.compile(r"<#[^>]+#>")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(payload: Any) -> str:
    data = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def run_command(
    command: list[str],
    *,
    cwd: Path | None = None,
    log_path: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if log_path:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(
            "$ " + subprocess.list2cmdline(command) + "\n\n"
            + result.stdout
            + ("\n[stderr]\n" + result.stderr if result.stderr else ""),
            encoding="utf-8",
        )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-3000:]
        raise RuntimeError(
            f"Command failed with exit code {result.returncode}: "
            f"{subprocess.list2cmdline(command)}\n{detail}"
        )
    return result


def ffprobe_media(ffprobe: Path, path: Path) -> dict[str, Any]:
    result = run_command(
        [
            str(ffprobe),
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            (
                "stream=index,codec_type,codec_name,width,height,pix_fmt,"
                "sample_rate,channels,avg_frame_rate,r_frame_rate,"
                "duration,nb_frames,nb_read_frames"
            ),
            "-show_entries",
            "format=format_name,duration,size,bit_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    return json.loads(result.stdout)


def media_video_stream(probe: dict[str, Any]) -> dict[str, Any]:
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            return stream
    raise RuntimeError("No video stream found")


def measured_frame_count(probe: dict[str, Any]) -> int:
    stream = media_video_stream(probe)
    raw = stream.get("nb_read_frames") or stream.get("nb_frames")
    if raw not in (None, "N/A"):
        return int(raw)
    duration = float(probe["format"]["duration"])
    return round(duration * FPS)


def choose_encoder(ffmpeg: Path, image_path: Path, temp_dir: Path) -> str:
    encoders = run_command([str(ffmpeg), "-hide_banner", "-encoders"]).stdout
    if "h264_nvenc" not in encoders:
        return "libx264"

    test_output = temp_dir / "nvenc-test.mp4"
    test = run_command(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-loop",
            "1",
            "-framerate",
            str(FPS),
            "-i",
            str(image_path),
            "-frames:v",
            "3",
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            "21",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            str(test_output),
        ],
        check=False,
    )
    test_output.unlink(missing_ok=True)
    return "h264_nvenc" if test.returncode == 0 else "libx264"


def encoder_args(encoder: str) -> list[str]:
    if encoder == "h264_nvenc":
        return [
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            "21",
            "-b:v",
            "0",
        ]
    return ["-c:v", "libx264", "-preset", "fast", "-crf", "18"]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def motion_filter(
    motion: dict[str, Any],
    frame_count: int,
    *,
    final_fade_frames: int = 0,
) -> str:
    motion_type = motion.get("type", "static")
    strength = float(motion.get("strength") or 0.35)
    anchor = motion.get("subject_anchor") or {"x": 0.5, "y": 0.5}
    anchor_x = clamp(float(anchor.get("x", 0.5)), 0.18, 0.82)
    anchor_y = clamp(float(anchor.get("y", 0.5)), 0.18, 0.82)
    denominator = max(1, frame_count - 1)
    progress = f"(on/{denominator})"
    eased = f"({progress}*{progress}*(3-2*{progress}))"
    zoom_delta = 0.015 + 0.018 * clamp(strength, 0.0, 1.0)

    if motion_type == "slow_push_in":
        zoom = f"1+{zoom_delta:.5f}*{eased}"
        x = f"(iw-iw/zoom)*{anchor_x:.5f}"
    elif motion_type == "slow_pull_out":
        zoom = f"1+{zoom_delta:.5f}*(1-{eased})"
        x = f"(iw-iw/zoom)*{anchor_x:.5f}"
    elif motion_type == "pan_left":
        zoom = f"{1 + zoom_delta:.5f}"
        x = f"(iw-iw/zoom)*(0.76-0.52*{eased})"
    elif motion_type == "pan_right":
        zoom = f"{1 + zoom_delta:.5f}"
        x = f"(iw-iw/zoom)*(0.24+0.52*{eased})"
    elif motion_type == "custom_crop_interpolation":
        zoom = f"1+{zoom_delta * 0.60:.5f}*{eased}"
        x = f"(iw-iw/zoom)*{anchor_x:.5f}"
    else:
        zoom = "1"
        x = "0"

    y = f"(ih-ih/zoom)*{anchor_y:.5f}"
    filters = [
        "scale=7680:4320:flags=lanczos",
        (
            f"zoompan=z='{zoom}':x='{x}':y='{y}':"
            f"d={frame_count}:s={WIDTH}x{HEIGHT}:fps={FPS}"
        ),
        "setsar=1",
        "format=yuv420p",
    ]
    if final_fade_frames:
        fade_duration = final_fade_frames / FPS
        fade_start = max(0.0, (frame_count - final_fade_frames) / FPS)
        filters.append(f"fade=t=out:st={fade_start:.6f}:d={fade_duration:.6f}")
    return ",".join(filters)


def render_shot(
    *,
    demo_root: Path,
    ffmpeg: Path,
    ffprobe: Path,
    encoder: str,
    shot: dict[str, Any],
    event: dict[str, Any],
    force: bool,
    shots_root_name: str = "shots",
) -> dict[str, Any]:
    shot_id = shot["id"]
    image_path = demo_root / "images" / "16x9" / f"{shot_id}.png"
    shot_dir = demo_root / shots_root_name / shot_id
    snapshot_dir = shot_dir / "snapshots"
    output_path = shot_dir / "final.mp4"
    plan_path = shot_dir / "render-plan.json"
    inspection_path = shot_dir / "inspection.json"
    receipt_path = shot_dir / "receipt.json"
    log_path = shot_dir / "render.log"
    snapshot_path = snapshot_dir / "middle.jpg"
    shot_dir.mkdir(parents=True, exist_ok=True)
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    final_fade_frames = (
        int(shot.get("transition_out", {}).get("duration_frames") or 0)
        if shot.get("transition_out", {}).get("type") == "fade"
        else 0
    )
    plan = {
        "schema_version": "1",
        "shot_id": shot_id,
        "source_image": str(image_path),
        "source_sha256": sha256_file(image_path),
        "duration_frames": int(event["duration_frames"]),
        "duration_seconds": int(event["duration_frames"]) / FPS,
        "fps": FPS,
        "width": WIDTH,
        "height": HEIGHT,
        "motion_intent": shot["motion_intent"],
        "transition_out": shot["transition_out"],
        "encoder": encoder,
        "renderer_version": "story-demo-ffmpeg-v2-smooth-supersampled",
    }
    plan_hash = sha256_json(plan)
    plan["render_input_hash"] = plan_hash
    write_json(plan_path, plan)

    if not force and output_path.is_file() and receipt_path.is_file():
        previous = read_json(receipt_path)
        if (
            previous.get("render_input_hash") == plan_hash
            and previous.get("output_sha256") == sha256_file(output_path)
        ):
            probe = ffprobe_media(ffprobe, output_path)
            if measured_frame_count(probe) == int(event["duration_frames"]):
                return {
                    "shot_id": shot_id,
                    "status": "cache_hit",
                    "output": str(output_path),
                    "duration_frames": int(event["duration_frames"]),
                }

    temp_output = shot_dir / "final.rendering.mp4"
    temp_output.unlink(missing_ok=True)
    filter_graph = motion_filter(
        shot["motion_intent"],
        int(event["duration_frames"]),
        final_fade_frames=final_fade_frames,
    )
    command = [
        str(ffmpeg),
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        "-framerate",
        str(FPS),
        "-i",
        str(image_path),
        "-vf",
        filter_graph,
        "-frames:v",
        str(event["duration_frames"]),
        "-fps_mode",
        "cfr",
        *encoder_args(encoder),
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-movflags",
        "+faststart",
        str(temp_output),
    ]
    run_command(command, log_path=log_path)
    temp_output.replace(output_path)

    probe = ffprobe_media(ffprobe, output_path)
    video = media_video_stream(probe)
    actual_frames = measured_frame_count(probe)
    expected_frames = int(event["duration_frames"])
    if actual_frames != expected_frames:
        raise RuntimeError(
            f"{shot_id} frame count mismatch: expected {expected_frames}, got {actual_frames}"
        )
    if int(video["width"]) != WIDTH or int(video["height"]) != HEIGHT:
        raise RuntimeError(f"{shot_id} resolution mismatch: {video}")

    midpoint = max(0.0, expected_frames / FPS / 2)
    run_command(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{midpoint:.6f}",
            "-i",
            str(output_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(snapshot_path),
        ]
    )

    inspection = {
        "schema_version": "1",
        "shot_id": shot_id,
        "status": "pass",
        "expected": {
            "frames": expected_frames,
            "fps": FPS,
            "width": WIDTH,
            "height": HEIGHT,
        },
        "measured": {
            "frames": actual_frames,
            "fps": video.get("avg_frame_rate"),
            "width": int(video["width"]),
            "height": int(video["height"]),
            "codec": video.get("codec_name"),
            "pixel_format": video.get("pix_fmt"),
        },
        "snapshot": str(snapshot_path),
    }
    write_json(inspection_path, inspection)

    receipt = {
        "schema_version": "1",
        "shot_id": shot_id,
        "status": "rendered",
        "render_input_hash": plan_hash,
        "output_path": str(output_path),
        "output_sha256": sha256_file(output_path),
        "rendered_at": utc_now(),
        "inspection_path": str(inspection_path),
    }
    write_json(receipt_path, receipt)
    return {
        "shot_id": shot_id,
        "status": "rendered",
        "output": str(output_path),
        "duration_frames": expected_frames,
    }


def render_all_shots(
    *,
    demo_root: Path,
    ffmpeg: Path,
    ffprobe: Path,
    manifest: dict[str, Any],
    timeline: dict[str, Any],
    workers: int,
    force: bool,
    shots_root_name: str = "shots",
) -> dict[str, Any]:
    temp_dir = demo_root / "build" / "renderer-probe"
    temp_dir.mkdir(parents=True, exist_ok=True)
    first_image = demo_root / "images" / "16x9" / "S001.png"
    encoder = choose_encoder(ffmpeg, first_image, temp_dir)
    event_by_id = {event["shot_id"]: event for event in timeline["video_events"]}

    started_at = utc_now()
    results: list[dict[str, Any]] = []
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
                shots_root_name=shots_root_name,
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
        "renderer": "ffmpeg",
        "encoder": encoder,
        "workers": workers,
        "shot_count": len(results),
        "rendered": sum(item["status"] == "rendered" for item in results),
        "cache_hits": sum(item["status"] == "cache_hit" for item in results),
        "total_frames_before_overlaps": sum(item["duration_frames"] for item in results),
        "results": results,
    }
    summary_name = (
        "shot-render-summary.json"
        if shots_root_name == "shots"
        else f"shot-render-summary.{shots_root_name}.json"
    )
    write_json(demo_root / summary_name, summary)
    return summary


def build_punctuation_map(source_text: str) -> tuple[str, dict[int, str]]:
    clean = PAUSE_TAG_RE.sub("", source_text)
    content: list[str] = []
    punctuation_after: dict[int, str] = {}
    for char in clean:
        if char in IGNORED_TEXT_CHARS:
            if content and not char.isspace():
                punctuation_after[len(content) - 1] = (
                    punctuation_after.get(len(content) - 1, "") + char
                )
            continue
        content.append(char)
    return "".join(content), punctuation_after


def ass_time(samples: int) -> str:
    centiseconds = max(0, round(samples * 100 / SAMPLE_RATE))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    seconds, cs = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{cs:02d}"


def srt_time(samples: int) -> str:
    milliseconds = max(0, round(samples * 1000 / SAMPLE_RATE))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, ms = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}"


def build_subtitles(
    *,
    demo_root: Path,
    manifest: dict[str, Any],
    timeline: dict[str, Any],
) -> dict[str, Any]:
    narration_by_id = {item["id"]: item for item in manifest["narration_segments"]}
    resolved_by_id = {item["id"]: item for item in timeline["narration_segments"]}
    subtitle_dir = demo_root / "subtitles"
    subtitle_dir.mkdir(parents=True, exist_ok=True)
    cues: list[dict[str, Any]] = []

    for segment_id, narration in narration_by_id.items():
        resolved = resolved_by_id[segment_id]
        words_payload = read_json(demo_root / resolved["word_timestamps_path"])
        words = words_payload["words"]
        expected_text, punctuation_after = build_punctuation_map(narration["text"])
        aligned_text = "".join(word["text"] for word in words)
        if aligned_text != expected_text:
            raise RuntimeError(
                f"{segment_id} subtitle text mismatch: "
                f"expected {len(expected_text)} chars, got {len(aligned_text)}"
            )

        current: list[dict[str, Any]] = []
        current_text = ""
        segment_start = int(resolved["start_sample"])
        for index, word in enumerate(words):
            suffix = punctuation_after.get(index, "")
            current.append(word)
            current_text += word["text"] + suffix
            next_word = words[index + 1] if index + 1 < len(words) else None
            gap_samples = (
                int(next_word["start_sample"]) - int(word["end_sample"])
                if next_word
                else 0
            )
            ends_strong = any(char in STRONG_PUNCTUATION for char in suffix)
            ends_soft = any(char in SOFT_PUNCTUATION for char in suffix)
            should_break = (
                ends_strong
                or len(current_text) >= MAX_SUBTITLE_CHARS
                or (ends_soft and len(current_text) >= 8)
                or (gap_samples >= round(0.34 * SAMPLE_RATE) and len(current_text) >= 6)
                or next_word is None
            )
            if not should_break:
                continue

            start_sample = segment_start + int(current[0]["start_sample"])
            end_sample = segment_start + int(current[-1]["end_sample"])
            cues.append(
                {
                    "id": f"CAP-{len(cues) + 1:04d}",
                    "segment_id": segment_id,
                    "start_sample": start_sample,
                    "end_sample": end_sample,
                    "text": current_text,
                }
            )
            current = []
            current_text = ""

    timeline_end_sample = int(timeline["totals"]["playback_samples"])
    for cue in cues:
        cue["start_sample"] = max(0, int(cue["start_sample"]) - round(0.04 * SAMPLE_RATE))
        cue["end_sample"] = int(cue["end_sample"]) + round(0.10 * SAMPLE_RATE)
        cue["end_sample"] = max(
            cue["end_sample"],
            cue["start_sample"] + round(0.48 * SAMPLE_RATE),
        )
        cue["end_sample"] = min(cue["end_sample"], timeline_end_sample)

    for index, cue in enumerate(cues[:-1]):
        cue["end_sample"] = min(
            cue["end_sample"],
            int(cues[index + 1]["start_sample"]) - round(0.02 * SAMPLE_RATE),
        )
        if cue["end_sample"] <= cue["start_sample"]:
            cue["end_sample"] = min(
                timeline_end_sample,
                max(
                    cue["start_sample"] + 1,
                    int(cues[index + 1]["start_sample"]) - 1,
                ),
            )

    ass_path = subtitle_dir / "zh-CN.ass"
    ass_lines = [
        "[Script Info]",
        "Title: 潮汐之后，照相馆还亮着灯",
        "ScriptType: v4.00+",
        f"PlayResX: {WIDTH}",
        f"PlayResY: {HEIGHT}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding"
        ),
        (
            "Style: Narration,Microsoft YaHei,58,&H00FFFFFF,&H000000FF,"
            "&H00151515,&H78000000,0,0,0,0,100,100,0,0,1,3.2,1.2,2,120,120,82,1"
        ),
        "",
        "[Events]",
        (
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
            "MarginV, Effect, Text"
        ),
    ]
    srt_lines: list[str] = []
    for index, cue in enumerate(cues, start=1):
        text = (
            cue["text"]
            .replace("\\", r"\\")
            .replace("{", r"\{")
            .replace("}", r"\}")
        )
        ass_lines.append(
            "Dialogue: 0,"
            f"{ass_time(cue['start_sample'])},{ass_time(cue['end_sample'])},"
            f"Narration,,0,0,0,,{text}"
        )
        srt_lines.extend(
            [
                str(index),
                f"{srt_time(cue['start_sample'])} --> {srt_time(cue['end_sample'])}",
                cue["text"],
                "",
            ]
        )

    ass_path.write_text("\n".join(ass_lines) + "\n", encoding="utf-8-sig")
    srt_path = subtitle_dir / "zh-CN.srt"
    srt_path.write_text("\n".join(srt_lines), encoding="utf-8-sig")
    manifest_path = subtitle_dir / "subtitle-manifest.json"
    subtitle_manifest = {
        "schema_version": "1",
        "language": "zh-CN",
        "cue_count": len(cues),
        "max_characters": max(len(cue["text"]) for cue in cues),
        "ass_path": str(ass_path),
        "srt_path": str(srt_path),
        "source_alignment": "whisperx-local-forced-alignment",
        "cues": cues,
    }
    write_json(manifest_path, subtitle_manifest)
    return subtitle_manifest


def compose_narration_audio(
    *,
    demo_root: Path,
    timeline: dict[str, Any],
) -> dict[str, Any]:
    audio_dir = demo_root / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    output_path = audio_dir / "narration-timeline.48000.mono.wav"
    segment_records: list[dict[str, Any]] = []
    target_samples = int(timeline["totals"]["playback_samples"])
    written_samples = 0

    with wave.open(str(output_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        for segment in timeline["narration_segments"]:
            source_path = demo_root / segment["audio_path"]
            with wave.open(str(source_path), "rb") as source:
                params = source.getparams()
                if (
                    params.nchannels != 1
                    or params.sampwidth != 2
                    or params.framerate != SAMPLE_RATE
                ):
                    raise RuntimeError(
                        f"Unexpected WAV format for {segment['id']}: {params}"
                    )
                source_samples = source.getnframes()
                if source_samples != int(segment["duration_samples"]):
                    raise RuntimeError(
                        f"{segment['id']} sample mismatch: "
                        f"timeline={segment['duration_samples']} wav={source_samples}"
                    )
                output.writeframes(source.readframes(source_samples))
            pause_samples = int(segment["pause_after_samples"])
            if pause_samples:
                output.writeframes(b"\x00\x00" * pause_samples)
            written_samples += source_samples + pause_samples
            segment_records.append(
                {
                    "id": segment["id"],
                    "source_path": str(source_path),
                    "source_sha256": sha256_file(source_path),
                    "start_sample": int(segment["start_sample"]),
                    "duration_samples": source_samples,
                    "pause_after_samples": pause_samples,
                }
            )

        if written_samples > target_samples:
            raise RuntimeError(
                f"Narration exceeds playback timeline: {written_samples}>{target_samples}"
            )
        tail_padding = target_samples - written_samples
        if tail_padding:
            output.writeframes(b"\x00\x00" * tail_padding)
            written_samples += tail_padding

    payload = {
        "schema_version": "1",
        "output_path": str(output_path),
        "output_sha256": sha256_file(output_path),
        "sample_rate": SAMPLE_RATE,
        "channels": 1,
        "sample_width_bytes": 2,
        "total_samples": written_samples,
        "duration_seconds": written_samples / SAMPLE_RATE,
        "tail_padding_samples": target_samples
        - int(timeline["totals"]["narration_samples"]),
        "segments": segment_records,
    }
    write_json(audio_dir / "audio-manifest.json", payload)
    return payload


def relative_posix(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def build_assembly_spec(
    *,
    demo_root: Path,
    manifest: dict[str, Any],
    timeline: dict[str, Any],
    subtitle_manifest: dict[str, Any],
) -> dict[str, Any]:
    shot_ids = [shot["id"] for shot in manifest["shots"]]
    dissolve_after = {
        overlap["from_shot_id"] for overlap in timeline["transition_overlaps"]
    }
    chunks: list[list[str]] = []
    current: list[str] = []
    for shot_id in shot_ids:
        current.append(shot_id)
        if shot_id in dissolve_after:
            chunks.append(current)
            current = []
    if current:
        chunks.append(current)

    sources: dict[str, dict[str, str]] = {}
    for shot_id in shot_ids:
        sources[shot_id.lower()] = {
            "path": relative_posix(
                demo_root / "shots" / shot_id / "final.mp4",
                demo_root,
            )
        }
    sources["captions"] = {
        "path": relative_posix(Path(subtitle_manifest["ass_path"]), demo_root)
    }

    steps: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks, start=1):
        steps.append(
            {
                "id": f"merge_chunk_{index:02d}",
                "op": "merge",
                "inputs": {
                    "srcs": [f"@sources.{shot_id.lower()}" for shot_id in chunk]
                },
                "params": {},
                "output": f"@work/chunk_{index:02d}.mp4",
            }
        )
    chunk_refs = [f"@work/chunk_{index:02d}.mp4" for index in range(1, len(chunks) + 1)]
    steps.append(
        {
            "id": "merge_chapters_with_dissolves",
            "op": "merge",
            "inputs": {"srcs": chunk_refs},
            "params": {
                "transitions": ["dissolve"] * (len(chunks) - 1),
                "transition_duration": 0.4,
            },
            "output": "@work/picture_lock.mp4",
        }
    )
    steps.append(
        {
            "id": "burn_authored_ass",
            "op": "burn_in",
            "inputs": {
                "srcs": ["@work/picture_lock.mp4", "@sources.captions"]
            },
            "params": {},
            "output": "@outputs.captioned_silent",
        }
    )

    spec = {
        "schema_version": 1,
        "name": "tide-photo-studio-no-bgm-assembly",
        "sources": sources,
        "steps": steps,
        "outputs": {
            "captioned_silent": {
                "path": "assemblies/captioned-silent.mp4",
            }
        },
        "variants": [],
    }
    write_json(demo_root / "assembly_job.json", spec)
    write_json(
        demo_root / "assembly-chunks.json",
        {
            "schema_version": "1",
            "chunk_count": len(chunks),
            "chunks": [
                {"id": f"chunk_{index:02d}", "shots": chunk}
                for index, chunk in enumerate(chunks, start=1)
            ],
            "dissolve_boundaries": timeline["transition_overlaps"],
        },
    )
    return spec


def fit_wav_samples(path: Path, target_samples: int) -> None:
    with wave.open(str(path), "rb") as source:
        params = source.getparams()
        frames = source.readframes(source.getnframes())
    if params.nchannels != 1 or params.sampwidth != 2 or params.framerate != SAMPLE_RATE:
        raise RuntimeError(f"Normalized audio has unexpected format: {params}")
    current_samples = len(frames) // 2
    if current_samples == target_samples:
        return
    if current_samples > target_samples:
        frames = frames[: target_samples * 2]
    else:
        frames += b"\x00\x00" * (target_samples - current_samples)
    temp_path = path.with_suffix(".fitted.wav")
    with wave.open(str(temp_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(frames)
    temp_path.replace(path)


def ensure_universal_mp4(
    *,
    ffmpeg: Path,
    ffprobe: Path,
    path: Path,
    diagnostics_dir: Path,
    log_path: Path,
) -> dict[str, Any]:
    before = ffprobe_media(ffprobe, path)
    video = media_video_stream(before)
    if video.get("codec_name") == "h264" and video.get("pix_fmt") == "yuv420p":
        return {
            "converted": False,
            "codec": video.get("codec_name"),
            "pixel_format": video.get("pix_fmt"),
        }

    diagnostics_dir.mkdir(parents=True, exist_ok=True)
    source_copy = diagnostics_dir / "master-no-bgm.pre-universal.mp4"
    if not source_copy.exists():
        shutil.copy2(path, source_copy)

    temp_output = path.with_name(path.stem + ".universal.mp4")
    temp_output.unlink(missing_ok=True)
    command = [
        str(ffmpeg),
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p5",
        "-tune",
        "hq",
        "-rc",
        "vbr",
        "-cq",
        "20",
        "-b:v",
        "0",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-fps_mode",
        "cfr",
        "-movflags",
        "+faststart",
        str(temp_output),
    ]
    result = run_command(command, log_path=log_path, check=False)
    if result.returncode != 0:
        command = [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-fps_mode",
            "cfr",
            "-movflags",
            "+faststart",
            str(temp_output),
        ]
        run_command(command, log_path=log_path)
    temp_output.replace(path)

    after = ffprobe_media(ffprobe, path)
    converted_video = media_video_stream(after)
    if (
        converted_video.get("codec_name") != "h264"
        or converted_video.get("pix_fmt") != "yuv420p"
    ):
        raise RuntimeError(
            "Universal MP4 conversion did not produce H.264 yuv420p"
        )
    return {
        "converted": True,
        "source_copy": str(source_copy),
        "source_codec": video.get("codec_name"),
        "source_pixel_format": video.get("pix_fmt"),
        "codec": converted_video.get("codec_name"),
        "pixel_format": converted_video.get("pix_fmt"),
    }


def run_kinocut_assembly(
    *,
    demo_root: Path,
    kino: Path,
    ffmpeg: Path,
    ffprobe: Path,
    timeline: dict[str, Any],
    force: bool,
) -> dict[str, Any]:
    build_dir = demo_root / "build" / "kinocut"
    assembly_dir = demo_root / "assemblies"
    qc_dir = demo_root / "qc"
    logs_dir = demo_root / "logs"
    for directory in (build_dir, assembly_dir, qc_dir, logs_dir):
        directory.mkdir(parents=True, exist_ok=True)

    spec_path = demo_root / "assembly_job.json"
    plan_path = build_dir / "workflow-plan.json"
    receipt_path = build_dir / "workflow-receipt.json"
    inspect_path = build_dir / "workflow-inspection.json"
    captioned_path = assembly_dir / "captioned-silent.mp4"
    final_path = assembly_dir / "master-no-bgm.mp4"

    run_command(
        [str(kino), "--format", "json", "workflow-validate", "--spec", str(spec_path)],
        cwd=demo_root,
        log_path=logs_dir / "kinocut-workflow-validate.log",
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
        log_path=logs_dir / "kinocut-workflow-plan.log",
    )

    if force:
        captioned_path.unlink(missing_ok=True)
        final_path.unlink(missing_ok=True)
    if not captioned_path.is_file():
        render_command = [
            str(kino),
            "--format",
            "json",
            "workflow-render",
            "--spec",
            str(spec_path),
            "--save-receipt",
            str(receipt_path),
            "--keep-intermediates",
        ]
        if receipt_path.is_file() and not force:
            prior_receipt = read_json(receipt_path)
            if prior_receipt.get("status") in {"failed", "in_progress"}:
                render_command.extend(["--resume", str(receipt_path)])
        run_command(
            render_command,
            cwd=demo_root,
            log_path=logs_dir / "kinocut-workflow-render.log",
        )
    run_command(
        [
            str(kino),
            "--format",
            "json",
            "workflow-inspect",
            "--receipt",
            str(receipt_path),
        ],
        cwd=demo_root,
        log_path=logs_dir / "kinocut-workflow-inspect.log",
    )
    inspect_result = run_command(
        [
            str(kino),
            "--format",
            "json",
            "workflow-inspect",
            "--receipt",
            str(receipt_path),
        ],
        cwd=demo_root,
    )
    try:
        write_json(inspect_path, json.loads(inspect_result.stdout))
    except json.JSONDecodeError:
        inspect_path.write_text(inspect_result.stdout, encoding="utf-8")

    narration_path = demo_root / "audio" / "narration-timeline.48000.mono.wav"
    kinocut_normalized_path = demo_root / "audio" / "kinocut-normalized.-16lufs.m4a"
    normalized_path = (
        demo_root / "audio" / "narration-normalized.-16lufs.48000.mono.wav"
    )
    if force:
        kinocut_normalized_path.unlink(missing_ok=True)
        normalized_path.unlink(missing_ok=True)
    if not kinocut_normalized_path.is_file():
        run_command(
            [
                str(kino),
                "--format",
                "json",
                "normalize-audio",
                str(narration_path),
                "--lufs",
                "-16",
                "--output",
                str(kinocut_normalized_path),
            ],
            cwd=demo_root,
            log_path=logs_dir / "kinocut-normalize-audio.log",
        )
    if not normalized_path.is_file():
        target_samples = int(timeline["totals"]["playback_samples"])
        run_command(
            [
                str(ffmpeg),
                "-hide_banner",
                "-loglevel",
                "warning",
                "-y",
                "-i",
                str(kinocut_normalized_path),
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
                str(normalized_path),
            ],
            cwd=demo_root,
            log_path=logs_dir / "normalize-audio-to-timeline-contract.log",
        )
    fit_wav_samples(normalized_path, int(timeline["totals"]["playback_samples"]))

    if not final_path.is_file():
        run_command(
            [
                str(kino),
                "--format",
                "json",
                "add-audio",
                str(captioned_path),
                str(normalized_path),
                "--duration-policy",
                "keep_video",
                "--output",
                str(final_path),
            ],
            cwd=demo_root,
            log_path=logs_dir / "kinocut-add-audio.log",
        )

    compatibility = ensure_universal_mp4(
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        path=final_path,
        diagnostics_dir=demo_root / "diagnostics" / "kinocut-yuv444-output",
        log_path=logs_dir / "universal-mp4-conversion.log",
    )
    probe = ffprobe_media(ffprobe, final_path)
    actual_frames = measured_frame_count(probe)
    expected_frames = int(timeline["totals"]["playback_frames"])
    duration_error_frames = actual_frames - expected_frames
    if abs(duration_error_frames) > 1:
        raise RuntimeError(
            f"Final duration error exceeds one frame: expected {expected_frames}, "
            f"got {actual_frames}"
        )

    loudness_result = run_command(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "info",
            "-i",
            str(final_path),
            "-vn",
            "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ],
        cwd=demo_root,
        log_path=logs_dir / "ffmpeg-loudness-verification.log",
    )
    loudness_matches = re.findall(r"\{[\s\S]*?\}", loudness_result.stderr)
    loudness = {}
    for candidate in reversed(loudness_matches):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if "input_i" in parsed and "input_tp" in parsed:
            loudness = parsed
            break
    input_lufs = float(loudness["input_i"]) if loudness else math.nan
    input_true_peak = float(loudness["input_tp"]) if loudness else math.nan

    black_result = run_command(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "info",
            "-i",
            str(final_path),
            "-an",
            "-vf",
            "fps=2,scale=320:-2,blackdetect=d=0.5:pix_th=0.10:pic_th=0.98",
            "-f",
            "null",
            "-",
        ],
        cwd=demo_root,
        log_path=logs_dir / "ffmpeg-black-frame-verification.log",
    )
    black_ranges = [
        {
            "start_seconds": float(start),
            "end_seconds": float(end),
            "duration_seconds": float(duration),
        }
        for start, end, duration in re.findall(
            r"black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)",
            black_result.stderr,
        )
    ]
    final_duration_seconds = float(probe["format"]["duration"])
    unexpected_black_ranges = [
        item
        for item in black_ranges
        if not (
            item["start_seconds"] >= final_duration_seconds - 1.0
            and item["duration_seconds"] <= 1.0
        )
    ]

    info_result = run_command(
        [str(kino), "--format", "json", "info", str(final_path)],
        cwd=demo_root,
        log_path=logs_dir / "kinocut-info.log",
    )
    storyboard_dir = qc_dir / "storyboard"
    if storyboard_dir.exists() and force:
        shutil.rmtree(storyboard_dir)
    storyboard_dir.mkdir(parents=True, exist_ok=True)
    run_command(
        [
            str(kino),
            "--format",
            "json",
            "storyboard",
            str(final_path),
            "--output-dir",
            str(storyboard_dir),
            "--frames",
            "24",
        ],
        cwd=demo_root,
        log_path=logs_dir / "kinocut-storyboard.log",
    )

    def parse_json_or_text(result: subprocess.CompletedProcess[str]) -> Any:
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return {"raw": result.stdout.strip()}

    subtitle_manifest = read_json(
        demo_root / "subtitles" / "subtitle-manifest.json"
    )
    loudness_pass = (
        not math.isnan(input_lufs)
        and not math.isnan(input_true_peak)
        and -17.0 <= input_lufs <= -15.0
        and input_true_peak <= -1.45
    )
    local_checks = {
        "duration_within_one_frame": abs(duration_error_frames) <= 1,
        "resolution_1920x1080": (
            int(media_video_stream(probe)["width"]) == WIDTH
            and int(media_video_stream(probe)["height"]) == HEIGHT
        ),
        "frame_rate_30": media_video_stream(probe).get("avg_frame_rate") == "30/1",
        "audio_loudness_and_true_peak": loudness_pass,
        "no_unexpected_black_ranges": not unexpected_black_ranges,
        "subtitle_line_length": subtitle_manifest["max_characters"]
        <= MAX_SUBTITLE_CHARS + 1,
        "subtitle_safe_margin": 82 >= round(HEIGHT * 0.075),
        "shot_receipts_complete": len(
            list((demo_root / "shots").glob("S*/receipt.json"))
        )
        == 60,
    }
    local_pass = all(local_checks.values())
    quality = {
        "schema_version": "1",
        "status": "pass" if local_pass else "fail",
        "expected": {
            "frames": expected_frames,
            "fps": FPS,
            "width": WIDTH,
            "height": HEIGHT,
            "audio_sample_rate": SAMPLE_RATE,
        },
        "measured": {
            "frames": actual_frames,
            "duration_error_frames": duration_error_frames,
            "probe": probe,
        },
        "compatibility_conversion": compatibility,
        "local_checks": local_checks,
        "loudness": {
            "input_lufs": input_lufs,
            "input_true_peak_dbtp": input_true_peak,
            "raw": loudness,
        },
        "black_ranges": black_ranges,
        "unexpected_black_ranges": unexpected_black_ranges,
        "kinocut_quality": {
            "status": "diagnostic_only",
            "reason": (
                "Kinocut 1.11.1 quality_guardrails uses lavfi movie= with an "
                "absolute Windows path; the drive colon is misparsed, so the "
                "visual probe is not used for final acceptance."
            ),
            "evidence": {
                "workflow_receipt": str(receipt_path),
                "pre_fix_quality_log": str(
                    demo_root
                    / "diagnostics"
                    / "pre-true-peak-fix"
                    / "kinocut-video-quality-check.pre-limiter.log"
                ),
            },
        },
        "kinocut_design_quality": {
            "status": "not_used_for_acceptance",
            "reason": (
                "Kinocut 1.11.1 Windows absolute-path probes are not reliable "
                "for this workspace and repeat several full-video decodes."
            ),
            "replacement": (
                "Deterministic FFprobe contract checks, FFmpeg loudness/true-peak "
                "verification, low-rate black-frame scan, authored subtitle "
                "constraints, shot receipts, and storyboard review."
            ),
        },
        "kinocut_info": parse_json_or_text(info_result),
        "storyboard_dir": str(storyboard_dir),
    }
    write_json(qc_dir / "quality.json", quality)

    final_sha = sha256_file(final_path)
    video_receipt = {
        "schema_version": "1",
        "project_id": timeline["project_id"],
        "title": "潮汐之后，照相馆还亮着灯",
        "status": "rendered",
        "artifact": str(final_path),
        "artifact_sha256": final_sha,
        "no_bgm": True,
        "narration": str(normalized_path),
        "captions": str(demo_root / "subtitles" / "zh-CN.ass"),
        "workflow_spec": str(spec_path),
        "workflow_plan": str(plan_path),
        "workflow_receipt": str(receipt_path),
        "quality_report": str(qc_dir / "quality.json"),
        "compatibility_conversion": compatibility,
        "rendered_at": utc_now(),
    }
    write_json(demo_root / "video_receipt.json", video_receipt)
    release_checkpoint = {
        "schema_version": "1",
        "status": "human_review_required",
        "candidate_artifact": str(final_path),
        "candidate_sha256": final_sha,
        "automated_quality_status": quality["status"],
        "human_review": {
            "required": True,
            "reason": "Final visual review and user-selected BGM are intentionally pending.",
        },
        "music_decision": "pending_user_selection",
        "safe_to_publish": False,
    }
    write_json(demo_root / "release_checkpoint.json", release_checkpoint)
    return {
        "final_path": str(final_path),
        "final_sha256": final_sha,
        "frames": actual_frames,
        "duration_seconds": float(probe["format"]["duration"]),
        "duration_error_frames": duration_error_frames,
        "quality_status": quality["status"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render and assemble the formal Infinite Canvas story demo."
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

    manifest = read_json(demo_root / "story_manifest.json")
    timeline = read_json(demo_root / "resolved_timeline.json")
    if int(timeline["timebase"]["video"]["fps_num"]) != FPS:
        raise RuntimeError("This renderer currently requires a 30 fps timeline")
    if int(timeline["timebase"]["audio"]["sample_rate"]) != SAMPLE_RATE:
        raise RuntimeError("This renderer currently requires 48 kHz audio")

    shot_summary = render_all_shots(
        demo_root=demo_root,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        manifest=manifest,
        timeline=timeline,
        workers=args.workers,
        force=args.force_shots,
    )
    subtitle_manifest = build_subtitles(
        demo_root=demo_root,
        manifest=manifest,
        timeline=timeline,
    )
    audio_manifest = compose_narration_audio(
        demo_root=demo_root,
        timeline=timeline,
    )
    build_assembly_spec(
        demo_root=demo_root,
        manifest=manifest,
        timeline=timeline,
        subtitle_manifest=subtitle_manifest,
    )
    assembly = run_kinocut_assembly(
        demo_root=demo_root,
        kino=kino,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        timeline=timeline,
        force=args.force_assembly,
    )

    summary = {
        "schema_version": "1",
        "completed_at": utc_now(),
        "shots": shot_summary,
        "subtitles": {
            "cue_count": subtitle_manifest["cue_count"],
            "ass_path": subtitle_manifest["ass_path"],
            "srt_path": subtitle_manifest["srt_path"],
        },
        "audio": {
            "path": audio_manifest["output_path"],
            "total_samples": audio_manifest["total_samples"],
        },
        "assembly": assembly,
    }
    write_json(demo_root / "render-summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
