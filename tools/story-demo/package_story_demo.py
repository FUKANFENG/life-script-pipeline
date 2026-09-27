from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path


DELIVERY_FILES = {
    "assemblies/separated/video-only.mp4": "tracks/01-video-only.mp4",
    "assemblies/separated/narration-48k-mono.wav": (
        "tracks/02-narration-48k-mono.wav"
    ),
    "assemblies/separated/subtitles-zh-CN.srt": (
        "tracks/03-subtitles-zh-CN.srt"
    ),
    "FINAL_REPORT.md": "FINAL_REPORT.md",
    "README.md": "README.md",
    "manual-review.md": "manual-review.md",
    "experiment-log.md": "experiment-log.md",
    "story-plan.json": "story-plan.json",
    "story_manifest.json": "story_manifest.json",
    "resolved_timeline.json": "resolved_timeline.json",
    "subtitles/subtitle-manifest.json": "subtitles/subtitle-manifest.json",
    "qc/separated-tracks-quality.json": "qc/separated-tracks-quality.json",
    "qc/separated-storyboard-grid.jpg": "qc/separated-storyboard-grid.jpg",
    "separated-delivery-manifest.json": "separated-delivery-manifest.json",
    "separated-transition-plan.json": "separated-transition-plan.json",
    "assembly_job.separated.json": "assembly_job.separated.json",
    "build/kinocut-separated/workflow-plan.json": (
        "kinocut/workflow-plan.json"
    ),
    "build/kinocut-separated/workflow-receipt.json": (
        "kinocut/workflow-receipt.json"
    ),
    "build/kinocut-separated/workflow-inspection.json": (
        "kinocut/workflow-inspection.json"
    ),
    "music_decision.template.json": "music_decision.template.json",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def link_or_copy(source: Path, target: Path) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
    try:
        os.link(source, target)
        return "hardlink"
    except OSError:
        shutil.copy2(source, target)
        return "copy"


def build_package(demo_root: Path) -> dict:
    demo_root = demo_root.resolve()
    delivery_dir = demo_root / "delivery"
    delivery_dir.mkdir(parents=True, exist_ok=True)

    records = []
    for source_relative, delivery_relative in DELIVERY_FILES.items():
        source = demo_root / source_relative
        if not source.is_file():
            raise FileNotFoundError(source)
        target = delivery_dir / delivery_relative
        mode = link_or_copy(source, target)
        records.append(
            {
                "source": source_relative,
                "delivery": delivery_relative,
                "size_bytes": source.stat().st_size,
                "sha256": sha256_file(source),
                "materialization": mode,
            }
        )

    manifest = {
        "schema_version": "1",
        "project_id": "tide-photo-studio-demo-2026-07-31",
        "title": "潮汐之后，照相馆还亮着灯",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "full_process_root": str(demo_root),
        "delivery_root": str(delivery_dir),
        "file_count": len(records),
        "total_size_bytes": sum(item["size_bytes"] for item in records),
        "files": records,
        "package": None,
    }
    root_manifest = demo_root / "archive-manifest.json"
    delivery_manifest = delivery_dir / "archive-manifest.json"
    write_json(root_manifest, manifest)
    write_json(delivery_manifest, manifest)

    package_path = (
        delivery_dir
        / "tide-photo-studio-demo-separated-delivery-2026-07-31.zip"
    )
    package_path.unlink(missing_ok=True)
    with zipfile.ZipFile(package_path, "w", allowZip64=True) as archive:
        package_files = [
            delivery_dir / record["delivery"] for record in records
        ]
        package_files.append(delivery_manifest)
        for path in package_files:
            relative = path.relative_to(delivery_dir)
            suffix = path.suffix.lower()
            compression = (
                zipfile.ZIP_STORED
                if suffix in {
                    ".mp4",
                    ".wav",
                    ".jpg",
                    ".jpeg",
                    ".png",
                    ".m4a",
                }
                else zipfile.ZIP_DEFLATED
            )
            archive.write(path, relative.as_posix(), compress_type=compression)

    manifest["package"] = {
        "path": str(package_path),
        "size_bytes": package_path.stat().st_size,
        "sha256": sha256_file(package_path),
    }
    write_json(root_manifest, manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Build the separated video, voiceover, and subtitle delivery "
            "package for the story demo."
        )
    )
    parser.add_argument("--demo-root", required=True, type=Path)
    args = parser.parse_args()
    result = build_package(args.demo_root)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
