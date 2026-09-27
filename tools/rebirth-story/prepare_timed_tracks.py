from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


STORY_DEMO_TOOLS = Path(__file__).resolve().parents[1] / "story-demo"
sys.path.insert(0, str(STORY_DEMO_TOOLS))

from render_separated_delivery import prepare_subtitles, prepare_voiceover  # noqa: E402
from render_story_demo import (  # noqa: E402
    FPS,
    build_subtitles,
    compose_narration_audio,
    read_json,
    write_json,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Materialize the synchronized narration WAV and timecoded SRT."
    )
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    args = parser.parse_args()

    project = args.project.resolve()
    ffmpeg = args.ffmpeg.resolve()
    manifest = read_json(project / "story_manifest.json")
    timeline = read_json(project / "resolved_timeline.json")

    subtitle_source = build_subtitles(
        demo_root=project,
        manifest=manifest,
        timeline=timeline,
    )
    compose_narration_audio(demo_root=project, timeline=timeline)
    audio = prepare_voiceover(
        demo_root=project,
        ffmpeg=ffmpeg,
        timeline=timeline,
    )
    subtitles = prepare_subtitles(
        demo_root=project,
        target_duration_seconds=int(timeline["totals"]["playback_frames"]) / FPS,
    )
    report = {
        "schema_version": "1",
        "project_id": manifest["project_id"],
        "timeline_frames": int(timeline["totals"]["playback_frames"]),
        "timeline_samples": int(timeline["totals"]["playback_samples"]),
        "audio": audio,
        "subtitles": subtitles,
        "subtitle_source": subtitle_source["source_alignment"],
    }
    write_json(project / "timed-tracks-preparation.json", report)
    print(
        json.dumps(
            {
                "audio": audio["path"],
                "audio_samples": audio["samples"],
                "subtitles": subtitles["path"],
                "subtitle_cues": subtitles["cue_count"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
