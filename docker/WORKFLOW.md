# Docker story workflow

Before producing a story, read /app/docs/migration/STORY_PRODUCTION_PLAYBOOK.md.
This is a Linux container. Use container paths and installed executables, not Windows paths.

- Input scripts and references: /workspace/inbox/.
- Project files, intermediate artifacts and deliverables: /workspace/outputs/<project-id>/.
- Media Python: /opt/story-runtime/bin/python (also available as python).
- Alignment: /opt/local-aligner/bin/local-aligner. Read LOCAL_ALIGNER_DEVICE for CPU/CUDA.
- FFmpeg and ffprobe: /usr/bin/ffmpeg and /usr/bin/ffprobe.
- Canvas MCP: node /app/canvas-agent/dist/index.js mcp. The browser must be connected.
- XG: XG_API_BASE_URL and XG_API_KEY environment variables; browser requests use /xg-api.
- TTS: MINIMAX_API_KEY and MINIMAX_API_HOST environment variables. Never print or log keys.
- Deliver separate video-only MP4, continuous WAV, clean timed SRT, review workbench,
  a vertical cover, and publication text. Preserve timing when changing pictures.
- Give the user a duration/scene/shot plan before batch production. Keep their original text.
- The historical PowerShell runners and Kinocut experiments are reference material;
  they are not Linux entrypoints. Use Story Pipeline CLI and the PyAV review renderer.
- Do not open file managers or use desktop automation. Use download links or docker compose cp.
