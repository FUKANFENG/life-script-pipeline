from __future__ import annotations

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid
import wave

import av
from PIL import Image


def json_file(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def mock_xg() -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get("Authorization") != "Bearer docker-smoke-test-only":
                self.send_error(401)
                return
            self.send_response(200)
            if self.path == "/images/test.png":
                self.send_header("Content-Type", "image/png")
                self.end_headers()
                image = BytesIO()
                Image.new("RGB", (16, 9), "green").save(image, format="PNG")
                self.wfile.write(image.getvalue())
            else:
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":[{"id":"gpt-image-2"}]}')

        def log_message(self, *_args):
            pass

    HTTPServer(("0.0.0.0", 18080), Handler).serve_forever()


def run() -> None:
    base = "http://app:3000"
    config = json.loads((Path.home() / ".infinite-canvas/canvas-agent.json").read_text())
    headers = {"x-canvas-agent-token": config["token"]}

    def api(route: str, body: dict | None = None):
        request = Request(base + "/canvas-agent" + route, headers=headers)
        if body is not None:
            request.data = json.dumps(body).encode()
            request.add_header("Content-Type", "application/json")
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    for route in ("/", "/canvas/docker-smoke/review", "/healthz"):
        with urlopen(base + route, timeout=10) as response:
            assert response.status == 200, route
    assert os.geteuid() != 0
    assert "Docker story workflow" in Path("/workspace/AGENTS.md").read_text()
    with urlopen(base + "/config.js", timeout=10) as response:
        assert "docker-smoke-test-only" not in response.read().decode()
    try:
        urlopen(base + "/canvas-agent/agent/codex/workspace", timeout=5)
        raise AssertionError("Agent accepted a request without a token")
    except HTTPError as error:
        assert error.code == 401
    assert api("/agent/codex/workspace")["workspace"]["workspacePath"] == "/workspace"
    if "--verify-saved" in sys.argv:
        saved_id = sys.argv[sys.argv.index("--verify-saved") + 1]
        saved = api("/story-review/projects/" + saved_id)["project"]
        assert saved["shots"][0]["selectedVersionId"] == "v002"
        assert saved["shots"][0]["customReferences"][0]["label"] == "人物参考"
        assert saved["exports"]
        print(json.dumps({"persistence_passed": True, "project_id": saved_id}))
        return
    with urlopen(Request(base + "/canvas-agent/events?clientId=docker-smoke", headers=headers), timeout=5) as response:
        assert "text/event-stream" in response.headers["Content-Type"]

    project_id = "docker-smoke-" + uuid.uuid4().hex[:8]
    root = Path("/workspace/outputs") / project_id
    for directory in ("frames-16x9", "deliverables"):
        (root / directory).mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 180), "#345849").save(root / "frames-16x9/S001.png")
    audio = root / "deliverables/narration.wav"
    with wave.open(str(audio), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(48000)
        stream.writeframes(b"\0\0" * 48000)
    (root / "deliverables/subtitles.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\n测试，画面。\n", encoding="utf-8")
    json_file(root / "shot_manifest.json", {
        "project": "Docker smoke",
        "timeline": {"total_frames": 30, "total_samples": 48000, "total_seconds": 1},
        "shots": [{"id": "S001", "scene_id": "SC01", "prompt": "test", "narration": {
            "source_excerpt": "测试画面", "start_frame": 0, "end_frame": 30,
            "start_sample": 0, "end_sample": 48000, "start_seconds": 0, "end_seconds": 1,
        }}],
    })
    json_file(root / "media-export-manifest.json", {"project_id": project_id, "files": []})
    json_file(root / "ASSET_BIBLE.json", {"style": {}, "characters": [], "locations": [], "props": []})
    endpoint = "/story-review/projects/" + project_id
    initial = api(endpoint)["project"]
    image = BytesIO()
    Image.new("RGB", (320, 180), "#815641").save(image, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
    reference = api(endpoint + "/shots/S001/references", {"dataUrl": data_url, "width": 320, "height": 180, "label": "人物参考"})
    reference_id = reference["project"]["shots"][0]["customReferences"][0]["id"]
    changed = api(endpoint + "/shots/S001/versions", {
        "dataUrl": data_url, "width": 320, "height": 180, "source": "uploaded", "referenceIds": [reference_id],
    })["project"]
    assert changed["timeline"] == initial["timeline"]
    assert changed["shots"][0]["selectedVersionId"] == "v002"
    with urlopen(Request(base + "/canvas-agent" + endpoint + "/shots/S001/versions/v002/image", headers=headers), timeout=10) as response:
        assert Image.open(BytesIO(response.read())).size == (320, 180)
    job = api(endpoint + "/exports", {})["job"]
    for _ in range(60):
        job = api(endpoint + "/exports/" + job["id"])["job"]
        if job["status"] != "running":
            break
        time.sleep(1)
    assert job["status"] == "succeeded", job
    exported = root / "review/exports" / job["id"]
    receipt = json.loads((exported / "receipt.json").read_text())
    with av.open(str(root / receipt["files"]["video"]["path"])) as video:
        assert len(video.streams.video) == 1 and not video.streams.audio and not video.streams.subtitles
        assert (video.streams.video[0].width, video.streams.video[0].height) == (1920, 1080)
        assert sum(1 for _ in video.decode(video=0)) == 30
    assert receipt["files"]["audio"]["sha256"] == hashlib.sha256(audio.read_bytes()).hexdigest()
    with wave.open(str(root / receipt["files"]["audio"]["path"]), "rb") as stream:
        assert (stream.getnchannels(), stream.getframerate(), stream.getnframes()) == (1, 48000, 48000)
    for kind in ("video", "audio", "subtitles"):
        route = base + "/canvas-agent" + endpoint + "/exports/" + job["id"] + "/files/" + kind
        with urlopen(Request(route, headers=headers), timeout=10) as response:
            assert hashlib.sha256(response.read()).hexdigest() == receipt["files"][kind]["sha256"]
    subtitle = (root / receipt["files"]["subtitles"]["path"]).read_text(encoding="utf-8-sig")
    assert "测试画面" in subtitle and "，" not in subtitle and "。" not in subtitle
    with urlopen(base + "/xg-api/v1/models", timeout=10) as response:
        assert json.load(response)["data"][0]["id"] == "gpt-image-2"
    with urlopen(base + "/xg-api/images/test.png", timeout=10) as response:
        assert response.headers["Content-Type"] == "image/png"
        assert Image.open(BytesIO(response.read())).size == (16, 9)
    print(json.dumps({"passed": True, "project_id": project_id, "export_id": job["id"],
        "checks": ["SPA", "Agent authentication", "SSE", "workspace", "references", "image versions",
                   "fixed timeline", "MP4", "WAV", "clean SRT", "XG proxy auth", "XG image download"]}))


if __name__ == "__main__":
    mock_xg() if "--xg-mock" in sys.argv else run()
