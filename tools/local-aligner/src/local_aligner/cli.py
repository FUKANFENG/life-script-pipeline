from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .contracts import AlignRequest
from .doctor import inspect_environment
from .runtime import configure_ffmpeg_environment
from .shadow_asr import run_shadow_asr
from .whisperx_backend import align_known_transcript


def main() -> None:
    configure_ffmpeg_environment()
    parser = argparse.ArgumentParser(prog="local-aligner")
    commands = parser.add_subparsers(dest="command", required=True)

    doctor_parser = commands.add_parser("doctor")
    doctor_parser.add_argument("--json", action="store_true")
    doctor_parser.add_argument("--load-model", action="store_true")
    doctor_parser.add_argument("--device", default="cuda")

    for name in ["align", "shadow-asr"]:
        command_parser = commands.add_parser(name)
        command_parser.add_argument("request")
        command_parser.add_argument("result")

    args = parser.parse_args()
    if args.command == "doctor":
        result = inspect_environment(device=args.device, load_model=args.load_model)
        print(json.dumps(result, ensure_ascii=False, indent=None if args.json else 2))
        raise SystemExit(0 if result["ready"] else 2)

    request = AlignRequest.model_validate_json(Path(args.request).read_text(encoding="utf-8"))
    result = align_known_transcript(request) if args.command == "align" else run_shadow_asr(request)
    Path(args.result).write_text(
        json.dumps(
            result.model_dump(mode="json") if hasattr(result, "model_dump") else result,
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"local-aligner failed: {error}", file=sys.stderr)
        raise
