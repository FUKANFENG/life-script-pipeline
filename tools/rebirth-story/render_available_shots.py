from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import time
from pathlib import Path


STORY_DEMO_TOOLS = Path(__file__).resolve().parents[1] / "story-demo"
sys.path.insert(0, str(STORY_DEMO_TOOLS))

from render_separated_delivery import (  # noqa: E402
    SHOTS_ROOT_NAME,
    SOFT_TRANSITION_FRAMES,
    build_transition_plan,
)
from render_story_demo import (  # noqa: E402
    choose_encoder,
    read_json,
    render_shot,
    write_json,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render only story shots whose prepared images already exist."
    )
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--ffprobe", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--start-shot", type=int, default=1)
    parser.add_argument("--end-shot", type=int, default=9999)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    project = args.project.resolve()
    ffmpeg = args.ffmpeg.resolve()
    ffprobe = args.ffprobe.resolve()
    manifest = read_json(project / "story_manifest.json")
    timeline = read_json(project / "resolved_timeline.json")
    transition_plan = build_transition_plan(
        manifest=manifest,
        timeline=timeline,
        soft_transition_frames=SOFT_TRANSITION_FRAMES,
    )
    event_by_id = transition_plan["render_event_by_id"]
    shots = [
        shot
        for shot in manifest["shots"]
        if args.start_shot <= int(shot["id"][1:]) <= args.end_shot
        and (project / "images" / "16x9" / f"{shot['id']}.png").is_file()
    ]
    if not shots:
        raise RuntimeError("No prepared shots are available in the requested range")

    encoder = choose_encoder(
        ffmpeg,
        project / "images" / "16x9" / f"{shots[0]['id']}.png",
        project / "build" / "renderer-probe-v2",
    )
    started = time.perf_counter()
    results: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [
            pool.submit(
                render_shot,
                demo_root=project,
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
                encoder=encoder,
                shot=shot,
                event=event_by_id[shot["id"]],
                force=args.force,
                shots_root_name=SHOTS_ROOT_NAME,
            )
            for shot in shots
        ]
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda item: item["shot_id"])

    summary_path = project / "shot-render-summary.available.json"
    previous = read_json(summary_path) if summary_path.is_file() else {"results": []}
    merged = {item["shot_id"]: item for item in previous.get("results", [])}
    merged.update({item["shot_id"]: item for item in results})
    report = {
        "schema_version": "1",
        "encoder": encoder,
        "workers": args.workers,
        "elapsed_seconds": time.perf_counter() - started,
        "requested_range": [args.start_shot, args.end_shot],
        "rendered_this_run": len(results),
        "results": [merged[key] for key in sorted(merged)],
    }
    write_json(summary_path, report)
    print(
        json.dumps(
            {
                "encoder": encoder,
                "shots": len(results),
                "rendered": sum(item["status"] == "rendered" for item in results),
                "cache_hits": sum(item["status"] == "cache_hit" for item in results),
                "elapsed_seconds": report["elapsed_seconds"],
            }
        )
    )


if __name__ == "__main__":
    main()
