from __future__ import annotations

import os
import shutil
from pathlib import Path


def configure_ffmpeg_environment() -> str | None:
    configured = os.environ.get("FFMPEG_PATH")
    if configured:
        executable = Path(configured).expanduser().resolve()
        if not executable.is_file():
            return None
        directory = str(executable.parent)
        path_entries = os.environ.get("PATH", "").split(os.pathsep)
        if directory.casefold() not in {entry.casefold() for entry in path_entries if entry}:
            os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
        return str(executable)
    return shutil.which("ffmpeg")
