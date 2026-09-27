from __future__ import annotations

import json
from pathlib import Path


def project_directory() -> Path:
    return Path(__file__).resolve().parents[2]


def load_model_lock() -> dict[str, object]:
    return json.loads((project_directory() / "models.lock.json").read_text(encoding="utf-8"))
