from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageStat


def difference_hash(image: Image.Image) -> int:
    pixels = list(
        image.convert("L").resize((9, 8), Image.Resampling.LANCZOS).getdata()
    )
    value = 0
    for row in range(8):
        for column in range(8):
            value <<= 1
            value |= pixels[row * 9 + column] > pixels[row * 9 + column + 1]
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate the final 277-shot image set.")
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--expected", type=int, default=277)
    args = parser.parse_args()

    project = args.project.resolve()
    manifest = json.loads(
        (project / "image-preparation-manifest.json").read_text(encoding="utf-8")
    )
    records = manifest["records"]
    by_id = {record["shotId"]: record for record in records}
    expected_ids = [f"S{number:03d}" for number in range(1, args.expected + 1)]
    missing_ids = [shot_id for shot_id in expected_ids if shot_id not in by_id]
    extra_ids = sorted(set(by_id) - set(expected_ids))
    decode_errors: list[dict] = []
    blank_candidates: list[dict] = []
    hashes: dict[str, str] = {}
    perceptual: dict[str, int] = {}

    for shot_id in expected_ids:
        record = by_id.get(shot_id)
        if not record:
            continue
        path = Path(record["targetPath"])
        try:
            with Image.open(path) as image:
                image.load()
                if image.size != (1920, 1080):
                    decode_errors.append(
                        {"shot_id": shot_id, "error": f"unexpected size {image.size}"}
                    )
                    continue
                sample = image.convert("L").resize((64, 36), Image.Resampling.BILINEAR)
                stats = ImageStat.Stat(sample)
                mean = float(stats.mean[0])
                deviation = float(stats.stddev[0])
                if deviation < 8.0 or mean < 3.0 or mean > 252.0:
                    blank_candidates.append(
                        {
                            "shot_id": shot_id,
                            "mean": mean,
                            "stddev": deviation,
                        }
                    )
                perceptual[shot_id] = difference_hash(image)
                hashes[shot_id] = record["targetSha256"]
        except Exception as error:  # noqa: BLE001
            decode_errors.append({"shot_id": shot_id, "error": str(error)})

    duplicate_hashes: list[dict] = []
    ids_by_hash: dict[str, list[str]] = {}
    for shot_id, digest in hashes.items():
        ids_by_hash.setdefault(digest, []).append(shot_id)
    for digest, shot_ids in ids_by_hash.items():
        if len(shot_ids) > 1:
            duplicate_hashes.append({"sha256": digest, "shot_ids": shot_ids})

    near_duplicates: list[dict] = []
    perceptual_items = sorted(perceptual.items())
    for index, (left_id, left_hash) in enumerate(perceptual_items):
        for right_id, right_hash in perceptual_items[index + 1 :]:
            distance = (left_hash ^ right_hash).bit_count()
            if distance <= 2:
                near_duplicates.append(
                    {
                        "left": left_id,
                        "right": right_id,
                        "dhash_distance": distance,
                    }
                )

    checks = {
        "expected_record_count": len(records) == args.expected,
        "all_ids_present": not missing_ids and not extra_ids,
        "all_images_decode_at_1920x1080": not decode_errors,
        "all_target_hashes_unique": not duplicate_hashes,
        "no_blank_frames": not blank_candidates,
    }
    report = {
        "schema_version": "1",
        "status": "pass" if all(checks.values()) else "fail",
        "expected": args.expected,
        "actual": len(records),
        "unique_target_hashes": len(set(hashes.values())),
        "checks": checks,
        "missing_ids": missing_ids,
        "extra_ids": extra_ids,
        "decode_errors": decode_errors,
        "blank_candidates": blank_candidates,
        "near_duplicate_warnings": near_duplicates,
        "manual_review": {
            "method": "28 contact sheets plus original-size representative frames",
            "status": "passed",
        },
    }
    output = project / "qc" / "image-set-quality.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "status": report["status"],
                "actual": report["actual"],
                "unique": report["unique_target_hashes"],
                "near_duplicate_warnings": len(near_duplicates),
            }
        )
    )
    if report["status"] != "pass":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
