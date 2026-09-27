from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def output_suffix(mime_type: str) -> str:
    if mime_type == "image/jpeg":
        return ".jpg"
    if mime_type == "image/webp":
        return ".webp"
    return ".png"


def prepare_images(root: Path) -> dict:
    source_manifest_path = root / "final-image-node-map.json"
    if source_manifest_path.is_file():
        source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
        source_records = source_manifest["records"]
    else:
        source_manifest_path = root / "canvas-generation-progress.json"
        source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
        source_records = [
            {
                "shotId": record["shot_id"],
                "nodeId": record.get("image_node_id"),
                "localPath": record.get("local_path"),
            }
            for record in source_manifest["shots"]
            if record.get("status") == "success"
        ]
    output_dir = root / "images" / "16x9"
    contact_sheet_dir = root / "images" / "contact-sheets"
    output_dir.mkdir(parents=True, exist_ok=True)
    contact_sheet_dir.mkdir(parents=True, exist_ok=True)

    prepared = []
    for record in source_records:
        source_path = Path(record["localPath"])
        if not source_path.is_file():
            raise FileNotFoundError(f"Missing source image: {source_path}")

        with Image.open(source_path) as source:
            source.load()
            source_width, source_height = source.size
            crop_height = source_width * 9 // 16
            if crop_height > source_height:
                crop_width = source_height * 16 // 9
                left = (source_width - crop_width) // 2
                top = 0
                right = left + crop_width
                bottom = source_height
            else:
                crop_width = source_width
                left = 0
                top = (source_height - crop_height) // 2
                right = source_width
                bottom = top + crop_height

            frame = source.convert("RGB").crop((left, top, right, bottom))
            frame = frame.resize((1920, 1080), Image.Resampling.LANCZOS)
            target_path = output_dir / f"{record['shotId']}.png"
            frame.save(target_path, format="PNG", compress_level=6)

        prepared.append(
            {
                "shotId": record["shotId"],
                "nodeId": record["nodeId"],
                "sourcePath": str(source_path),
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "sourceSha256": sha256_file(source_path),
                "crop": {"left": left, "top": top, "right": right, "bottom": bottom},
                "targetPath": str(target_path),
                "targetWidth": 1920,
                "targetHeight": 1080,
                "targetSha256": sha256_file(target_path),
            }
        )

    contact_sheets = create_contact_sheets(prepared, contact_sheet_dir)
    manifest = {
        "schemaVersion": "1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceManifest": str(source_manifest_path),
        "requested": int(source_manifest.get("total", len(source_records))),
        "prepared": len(prepared),
        "uniqueSourceHashes": len({item["sourceSha256"] for item in prepared}),
        "uniqueTargetHashes": len({item["targetSha256"] for item in prepared}),
        "policy": {
            "crop": "center crop to 16:9",
            "resize": "1920x1080 Lanczos",
            "sourcePreserved": True,
        },
        "contactSheets": contact_sheets,
        "records": prepared,
    }
    manifest_path = root / "image-preparation-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def create_contact_sheets(prepared: list[dict], output_dir: Path) -> list[str]:
    columns = 5
    rows = 2
    tile_width = 384
    tile_height = 216
    label_height = 30
    sheet_paths = []
    font = ImageFont.load_default(size=20)

    for group_index in range(0, len(prepared), columns * rows):
        group = prepared[group_index : group_index + columns * rows]
        sheet = Image.new("RGB", (columns * tile_width, rows * (tile_height + label_height)), "#151515")
        draw = ImageDraw.Draw(sheet)
        for index, record in enumerate(group):
            column = index % columns
            row = index // columns
            x = column * tile_width
            y = row * (tile_height + label_height)
            with Image.open(record["targetPath"]) as frame:
                thumbnail = frame.convert("RGB").resize((tile_width, tile_height), Image.Resampling.LANCZOS)
            sheet.paste(thumbnail, (x, y))
            draw.text((x + 10, y + tile_height + 4), record["shotId"], fill="white", font=font)

        start_id = group[0]["shotId"]
        end_id = group[-1]["shotId"]
        sheet_path = output_dir / f"{start_id}-{end_id}.jpg"
        sheet.save(sheet_path, format="JPEG", quality=90, subsampling=0)
        sheet_paths.append(str(sheet_path))

    return sheet_paths


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare Infinite Canvas story images for 16:9 video review.")
    parser.add_argument("--root", required=True, type=Path, help="Demo output directory containing final-image-node-map.json.")
    args = parser.parse_args()
    manifest = prepare_images(args.root.resolve())
    print(
        json.dumps(
            {
                "prepared": manifest["prepared"],
                "uniqueTargetHashes": manifest["uniqueTargetHashes"],
                "contactSheets": len(manifest["contactSheets"]),
            }
        )
    )


if __name__ == "__main__":
    main()
