#!/usr/bin/env python3
"""Deterministic QA metrics for Chinese life-story narration scripts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path


DEFAULT_OPENING = "今天你要体验的人生副本是："
DEFAULT_SPEED = 4.472
MARKETING_TERMS = (
    "点赞",
    "订阅",
    "评论区",
    "下期视频",
    "关注我",
    "转发给",
    "大家好我是",
)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def normalized(text: str) -> str:
    kept: list[str] = []
    for char in text:
        if char.isspace():
            continue
        category = unicodedata.category(char)
        if category.startswith("P") or category.startswith("S"):
            continue
        kept.append(char)
    return "".join(kept)


def sentence_lengths(text: str) -> list[int]:
    sentences = [part.strip() for part in re.split(r"[。！？!?]+", text) if part.strip()]
    return [len(normalized(sentence)) for sentence in sentences]


def longest_overlap(source: str, output: str, minimum: int, maximum: int) -> tuple[int, str]:
    source_norm = normalized(source)
    output_norm = normalized(output)
    upper = min(maximum, len(source_norm), len(output_norm))
    for size in range(upper, minimum - 1, -1):
        source_grams = {
            source_norm[index : index + size]
            for index in range(0, len(source_norm) - size + 1)
        }
        for index in range(0, len(output_norm) - size + 1):
            candidate = output_norm[index : index + size]
            if candidate in source_grams:
                return size, candidate
    return 0, ""


def format_duration(seconds: float) -> str:
    whole = int(round(seconds))
    return f"{whole // 60}:{whole % 60:02d}"


def analyze(args: argparse.Namespace) -> dict[str, object]:
    source_path = args.source.resolve()
    output_path = args.output.resolve()
    source = read_text(source_path)
    output = read_text(output_path)

    spoken = normalized(output)
    paragraphs = [part.strip() for part in re.split(r"(?:\r?\n){2,}", output) if part.strip()]
    lengths = sentence_lengths(output)
    overlap_size, overlap_text = longest_overlap(
        source, output, args.overlap_threshold, args.max_overlap
    )
    marketing_hits = [term for term in MARKETING_TERMS if term in output]
    seconds = len(spoken) / args.speed if args.speed > 0 else 0.0

    warnings: list[str] = []
    if not output.startswith(args.opening):
        warnings.append("opening_mismatch")
    if output.count("你") == 0:
        warnings.append("second_person_missing")
    if marketing_hits:
        warnings.append("marketing_terms_present")
    if overlap_size >= args.overlap_threshold:
        warnings.append("source_overlap_too_long")

    return {
        "source_path": str(source_path),
        "output_path": str(output_path),
        "source_sha256": sha256(source_path),
        "output_sha256": sha256(output_path),
        "output_characters": len(output),
        "spoken_characters": len(spoken),
        "paragraphs": len(paragraphs),
        "sentences": len(lengths),
        "average_sentence_characters": round(sum(lengths) / len(lengths), 1) if lengths else 0,
        "maximum_sentence_characters": max(lengths) if lengths else 0,
        "second_person_count": output.count("你"),
        "estimated_seconds": round(seconds, 1),
        "estimated_duration": format_duration(seconds),
        "narration_speed": args.speed,
        "opening_correct": output.startswith(args.opening),
        "marketing_terms": marketing_hits,
        "longest_source_overlap": overlap_size,
        "overlap_text": overlap_text,
        "warnings": warnings,
        "passed": not warnings,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Original UTF-8 source text")
    parser.add_argument("--output", type=Path, required=True, help="Final UTF-8 narration text")
    parser.add_argument("--json", type=Path, help="Optional JSON report path")
    parser.add_argument("--speed", type=float, default=DEFAULT_SPEED)
    parser.add_argument("--opening", default=DEFAULT_OPENING)
    parser.add_argument("--overlap-threshold", type=int, default=8)
    parser.add_argument("--max-overlap", type=int, default=150)
    parser.add_argument("--strict", action="store_true", help="Exit non-zero when warnings exist")
    return parser.parse_args()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    result = analyze(args)
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    print(rendered)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(rendered + "\n", encoding="utf-8")
    return 2 if args.strict and not result["passed"] else 0


if __name__ == "__main__":
    sys.exit(main())
