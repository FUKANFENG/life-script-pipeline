from __future__ import annotations

import os
from pathlib import Path
import sys


workspace = Path(os.environ.get("INFINITE_CANVAS_WORKSPACE", "/workspace"))
workspace.mkdir(parents=True, exist_ok=True)
for name in ("inbox", "outputs"):
    (workspace / name).mkdir(exist_ok=True)
for name in ("tools", "canvas-agent", "docs", "README.md", "PIPELINE.md"):
    destination = workspace / name
    if not destination.exists() and not destination.is_symlink():
        destination.symlink_to(Path("/app") / name)

instructions = workspace / "AGENTS.md"
if not instructions.exists():
    instructions.write_text(
        "# Container story workspace\n\n"
        + Path("/app/canvas-agent/agent-instructions.md").read_text(encoding="utf-8")
        + "\n\n"
        + Path("/app/docker/WORKFLOW.md").read_text(encoding="utf-8"),
        encoding="utf-8",
    )

os.execvp(sys.argv[1], sys.argv[1:])
