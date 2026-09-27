from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageOps


FPS = 30
WIDTH = 1920
HEIGHT = 1080
SCENE_DISSOLVE_FRAMES = 8
OVERSCAN_X = 64
OVERSCAN_Y = 36
PAN_DISTANCE_X = 20
CUSTOM_DISTANCE_X = 16
CUSTOM_DISTANCE_Y = 10
ZOOM_AMOUNT = 0.035


def load_json(file: Path) -> dict:
    return json.loads(file.read_text(encoding="utf-8-sig"))


def sha256(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_file(root: Path, relative: str) -> Path:
    file = (root / relative).resolve()
    if file != root and root not in file.parents:
        raise ValueError("file path escapes project root")
    return file


def clean_subtitle_text(text: str) -> str:
    cleaned = "".join(char for char in text if char.isalnum() or char.isspace())
    return " ".join(cleaned.split())


def export_clean_srt(source: Path, output: Path) -> None:
    lines = source.read_text(encoding="utf-8-sig").splitlines()
    result = []
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.isdigit() or " --> " in stripped:
            result.append(stripped)
            continue
        display_text = clean_subtitle_text(stripped)
        if not display_text:
            raise ValueError(f"subtitle line {line_number} has no display text after cleaning")
        result.append(display_text)
    output.write_text("\ufeff" + "\n".join(result) + "\n", encoding="utf-8")


def image_source(file: Path) -> Image.Image:
    with Image.open(file) as source:
        image = ImageOps.fit(
            source.convert("RGB"),
            (WIDTH + OVERSCAN_X, HEIGHT + OVERSCAN_Y),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
    return image


def ease_in_out(progress: float) -> float:
    return progress * progress * (3.0 - 2.0 * progress)


def motion_frame(source: Image.Image, motion: str, frame_index: int, duration_frames: int, shot_id: str) -> np.ndarray:
    if motion == "static":
        left = (source.width - WIDTH) // 2
        top = (source.height - HEIGHT) // 2
        return np.ascontiguousarray(np.asarray(source.crop((left, top, left + WIDTH, top + HEIGHT)), dtype=np.uint8))

    progress = 0.5 if duration_frames <= 1 else frame_index / (duration_frames - 1)
    progress = ease_in_out(progress)
    center_x = source.width / 2
    center_y = source.height / 2
    zoom = 1.0
    if motion == "pan_left":
        center_x -= PAN_DISTANCE_X * progress
    elif motion == "pan_right":
        center_x += PAN_DISTANCE_X * progress
    elif motion == "slow_push_in":
        zoom = 1.0 + ZOOM_AMOUNT * progress
    elif motion == "slow_pull_out":
        zoom = 1.0 + ZOOM_AMOUNT * (1.0 - progress)
    elif motion == "custom_crop_interpolation":
        seed = int(hashlib.sha256(shot_id.encode("utf-8")).hexdigest()[:8], 16)
        center_x += (-1 if seed & 1 else 1) * CUSTOM_DISTANCE_X * progress
        center_y += (-1 if seed & 2 else 1) * CUSTOM_DISTANCE_Y * progress

    view_width = WIDTH / zoom
    view_height = HEIGHT / zoom
    left = center_x - view_width / 2
    top = center_y - view_height / 2
    right = left + view_width
    bottom = top + view_height
    rendered = source.transform(
        (WIDTH, HEIGHT),
        Image.Transform.EXTENT,
        (left, top, right, bottom),
        resample=Image.Resampling.BICUBIC,
    )
    return np.ascontiguousarray(np.asarray(rendered, dtype=np.uint8))


def encode_video(
    root: Path,
    export_dir: Path,
    project: dict,
    shot_manifest: dict,
    motion_policy: str,
    transition_policy: str,
) -> dict:
    shots_by_id = {item["id"]: item for item in project["shots"]}
    timeline_shots = shot_manifest["shots"]
    output = export_dir / "视频_无字幕_静音.mp4"
    expected_frames = sum(int(item["narration"]["end_frame"]) - int(item["narration"]["start_frame"]) for item in timeline_shots)
    container = av.open(str(output), mode="w", format="mp4", options={"movflags": "+faststart"})
    stream = container.add_stream("libx264", rate=FPS, options={"preset": "veryfast", "crf": "18", "tune": "stillimage"})
    stream.width = WIDTH
    stream.height = HEIGHT
    stream.pix_fmt = "yuv420p"
    stream.time_base = Fraction(1, FPS)
    stream.codec_context.time_base = Fraction(1, FPS)
    stream.codec_context.gop_size = FPS * 2

    frame_index = 0
    previous_array = None
    previous_scene = ""
    total = len(timeline_shots)
    for completed, timeline_shot in enumerate(timeline_shots, start=1):
        shot_id = timeline_shot["id"]
        review_shot = shots_by_id[shot_id]
        selected = next(item for item in review_shot["versions"] if item["id"] == review_shot["selectedVersionId"])
        source_image = image_source(safe_file(root, selected["file"]))
        duration_frames = int(timeline_shot["narration"]["end_frame"]) - int(timeline_shot["narration"]["start_frame"])
        scene_id = timeline_shot["scene_id"]
        scene_changed = previous_array is not None and scene_id != previous_scene
        should_dissolve = transition_policy == "dissolve_all" or (
            transition_policy == "scene_dissolve" and scene_changed
        )
        dissolve = min(SCENE_DISSOLVE_FRAMES, duration_frames) if previous_array is not None and should_dissolve else 0
        motion = "static" if motion_policy == "static" else str(timeline_shot.get("motion") or "static")
        static_array = motion_frame(source_image, "static", 0, duration_frames, shot_id) if motion == "static" else None
        current_array = None
        for shot_frame_index in range(duration_frames):
            current_array = static_array if static_array is not None else motion_frame(source_image, motion, shot_frame_index, duration_frames, shot_id)
            if shot_frame_index < dissolve and previous_array is not None:
                alpha = ease_in_out((shot_frame_index + 1) / dissolve)
                current_array = np.rint(previous_array.astype(np.float32) * (1 - alpha) + current_array.astype(np.float32) * alpha).astype(np.uint8)
            frame = av.VideoFrame.from_ndarray(current_array, format="rgb24")
            frame.pts = frame_index
            frame.time_base = Fraction(1, FPS)
            for packet in stream.encode(frame):
                container.mux(packet)
            frame_index += 1
        if current_array is None:
            raise ValueError(f"shot has no frames: {shot_id}")
        previous_array = current_array
        previous_scene = scene_id
        print(json.dumps({"type": "progress", "completed": completed, "total": total, "shotId": shot_id}), flush=True)

    for packet in stream.encode():
        container.mux(packet)
    container.close()
    if frame_index != expected_frames:
        raise ValueError(f"video frame mismatch: {frame_index} != {expected_frames}")
    with av.open(str(output)) as result:
        video_streams = list(result.streams.video)
        if len(video_streams) != 1 or list(result.streams.audio) or list(result.streams.subtitles):
            raise ValueError("video must contain exactly one video stream")
        decoded_frames = sum(1 for _ in result.decode(video=0))
    if decoded_frames != expected_frames:
        raise ValueError(f"decoded frame mismatch: {decoded_frames} != {expected_frames}")
    return {"path": output.relative_to(root).as_posix(), "sha256": sha256(output), "frames": decoded_frames, "durationSeconds": decoded_frames / FPS}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--export-id", required=True)
    parser.add_argument("--motion-policy", choices=("manifest", "static"), default="manifest")
    parser.add_argument("--transition-policy", choices=("scene_dissolve", "cut", "dissolve_all"), default="scene_dissolve")
    args = parser.parse_args()

    root = Path(args.project_root).resolve()
    project = load_json(root / "review" / "review-project.json")
    shot_manifest = load_json(root / "shot_manifest.json")
    export_dir = root / "review" / "exports" / args.export_id
    export_dir.mkdir(parents=True, exist_ok=False)

    selection = {
        "schemaVersion": "1.0",
        "projectId": project["id"],
        "timeline": project["timeline"],
        "renderPolicy": {"motion": args.motion_policy, "transition": args.transition_policy},
        "shots": [
            {
                "shotId": shot["id"],
                "selectedVersionId": shot["selectedVersionId"],
                "sha256": next(item["sha256"] for item in shot["versions"] if item["id"] == shot["selectedVersionId"]),
            }
            for shot in project["shots"]
        ],
    }
    selection_file = export_dir / "picture-lock.json"
    selection_file.write_text(json.dumps(selection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    video = encode_video(root, export_dir, project, shot_manifest, args.motion_policy, args.transition_policy)
    source_audio = safe_file(root, project["delivery"]["audioFile"])
    source_subtitles = safe_file(root, project["delivery"]["subtitleFile"])
    audio = export_dir / "配音_48k_mono.wav"
    subtitles = export_dir / "字幕.srt"
    shutil.copy2(source_audio, audio)
    export_clean_srt(source_subtitles, subtitles)
    if sha256(audio) != sha256(source_audio):
        raise ValueError("audio changed during export")

    receipt = {
        "schemaVersion": "1.0",
        "id": args.export_id,
        "projectId": project["id"],
        "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "pictureLock": {"path": selection_file.relative_to(root).as_posix(), "sha256": sha256(selection_file)},
        "timeline": project["timeline"],
        "renderPolicy": {"motion": args.motion_policy, "transition": args.transition_policy},
        "files": {
            "video": video,
            "audio": {"path": audio.relative_to(root).as_posix(), "sha256": sha256(audio)},
            "subtitles": {"path": subtitles.relative_to(root).as_posix(), "sha256": sha256(subtitles), "textPolicy": "punctuation_free"},
        },
        "contract": {"videoHasAudio": False, "videoHasBurnedSubtitles": False, "audioIsSeparate": True, "subtitleIsSeparate": True},
    }
    temporary = export_dir / "receipt.json.tmp"
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(export_dir / "receipt.json")
    print(json.dumps({"type": "complete", "exportId": args.export_id}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
