# Local Aligner

独立的 WhisperX 中文强制对齐进程。它不读取 MiniMax Key，也不依赖 Canvas Agent 的 Node 运行环境。

## 固定版本

- Python 3.11
- WhisperX 3.8.6（PyPI 稳定版）
- PyTorch 2.8.0 + CUDA 12.8
- 中文对齐模型 `jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn`
- 模型 revision `99ccb2737be22b8bb50dcfcc39ad4d567fb90cfd`

模型身份、版本和对齐配置写入 `models.lock.json`，并进入 Alignment Cache Key。
`uv.lock` 将 Windows/Linux 上的 `torch`、`torchaudio` 和 `torchvision` 显式绑定到官方 `cu128` 索引，其余依赖仍从 PyPI 安装。

## 安装

```powershell
uv sync --all-groups
$env:FFMPEG_PATH = 'C:\path\to\ffmpeg.exe'
```

## 诊断

只检查运行环境：

```powershell
uv run local-aligner doctor
```

同时下载并加载锁定的中文模型：

```powershell
uv run local-aligner doctor --load-model --device cuda
```

Canvas Agent 使用虚拟环境中的独立可执行文件：

```powershell
$env:STORY_ALIGNER_EXECUTABLE = (Resolve-Path '.venv\Scripts\local-aligner.exe').Path
$env:LOCAL_ALIGNER_DEVICE = 'cuda'
```

## 对齐

```powershell
uv run local-aligner align request.json result.json
```

请求包含已知正文和稳定词元。结果只返回稳定词元的整数采样边界，不把 ASR 转写作为正文真相。

请求协议：

```json
{
  "schema_version": "1",
  "backend": "whisperx",
  "audio_path": "C:\\project\\audio\\VO001.48000.mono.wav",
  "language": "zh",
  "text": "已知的完整旁白文本",
  "stable_tokens": [
    {
      "id": "VO001:T0001",
      "text": "已"
    }
  ],
  "segment": {
    "start_sample": 0,
    "end_sample": 1512000
  },
  "options": {
    "device": "cuda",
    "return_char_alignments": true,
    "interpolate_method": "nearest"
  }
}
```

输出协议只暴露中立字段：

```json
{
  "schema_version": "1",
  "backend": {
    "name": "whisperx",
    "model": "...",
    "model_revision": "...",
    "package_version": "3.8.6",
    "device": "cuda",
    "config": {}
  },
  "tokens": [
    {
      "token_id": "VO001:T0001",
      "start_sample": 12340,
      "end_sample": 25680,
      "confidence": 0.97
    }
  ],
  "unmatched_ranges": [],
  "warnings": [],
  "audio_sha256": "...",
  "text_sha256": "..."
}
```

## 影子 ASR

```powershell
uv run local-aligner shadow-asr request.json shadow-result.json
```

影子 ASR 使用 faster-whisper，只用于文本一致性、漏字和发音诊断，不进入正式时间线。

## 测试

```powershell
uv run pytest
```

本机离线验收结果保存在：

```text
../../canvas-agent/examples/story-pipeline/offline-alignment-acceptance.json
```
