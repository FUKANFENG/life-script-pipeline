# Story Pipeline

这部分实现以下稳定边界：

```text
story_manifest.json
    -> MiniMax HTTP TTS Adapter
    -> 48 kHz mono PCM WAV
    -> 独立 Alignment Cache
    -> Provider 时间戳质量门 / WhisperX 强制对齐
    -> resolved_timeline.json
```

`story_manifest.json` 只保存创作意图，`resolved_timeline.json` 只保存解析后的播放事实。Hyperframes、Kinocut 和 OTIO 的执行计划不进入这两层协议。

## 安全前提

曾在聊天、日志或文件中明文出现过的 MiniMax Key 必须先在控制台撤销。新 Key 仅通过当前进程的 `MINIMAX_API_KEY` 环境变量注入，不要写入 Manifest、配置文件或命令参数。

PowerShell 示例。真实 Key 通过隐藏输入注入，输入值不会进入命令历史：

```powershell
$secureKey = Read-Host 'MiniMax TTS Key' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $env:MINIMAX_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}
$env:MINIMAX_TTS_RPM = '10'
$env:MINIMAX_TTS_MAX_CONCURRENCY = '2'
$env:FFMPEG_PATH = 'C:\path\to\ffmpeg.exe'
$env:STORY_ALIGNER_EXECUTABLE = 'C:\path\to\infinite-canvas\tools\local-aligner\.venv\Scripts\local-aligner.exe'
$env:LOCAL_ALIGNER_DEVICE = 'cuda'
```

限流值是运行时配置，不在业务代码中固定为免费或付费账户的额度。

## 使用

先把 `risk-story-manifest.json` 中的 `voice_id` 替换成专用 Voice ID，然后验证协议：

```powershell
npm run build
node dist/index.js story validate examples/story-pipeline/risk-story-manifest.json
```

### Phase 1.5 真实金丝雀

先把以下两个 Manifest 中的占位 `voice_id` 替换为同一个实际音色：

- `phase-1.5-turbo-smoke-manifest.json`：约 10 秒，`speech-2.8-turbo`。
- `phase-1.5-canary-manifest.json`：约 31.5 秒，`speech-2.8-hd`。

建议把 `--project` 指向仓库外的私有目录。预检不会调用 MiniMax：

```powershell
node dist/index.js story canary-preflight examples/story-pipeline/phase-1.5-canary-manifest.json `
  --smoke examples/story-pipeline/phase-1.5-turbo-smoke-manifest.json `
  --project C:\private\minimax-canary-output `
  --ffmpeg $env:FFMPEG_PATH `
  --aligner $env:STORY_ALIGNER_EXECUTABLE
```

预检会分别验证 Turbo/HD 模型、时长、真实 `voice_id`，并实际执行 `<aligner> doctor --json`。全部显示 `PASS` 后执行：

```powershell
node dist/index.js story canary examples/story-pipeline/phase-1.5-canary-manifest.json `
  --smoke examples/story-pipeline/phase-1.5-turbo-smoke-manifest.json `
  --project C:\private\minimax-canary-output `
  --ffmpeg $env:FFMPEG_PATH `
  --aligner $env:STORY_ALIGNER_EXECUTABLE
```

命令严格按以下顺序运行：

```text
10 秒 Turbo 真实请求
→ 基础链路检查
→ 通过后才启动 31.5 秒 HD
→ Provider 时间戳质量门
→ WhisperX 强制回退探针
→ faster-whisper 影子 ASR
→ Provider/Local 偏差报告
→ 第二次执行验证 TTS/Alignment 独立缓存
```

Turbo 失败会立即阻断 HD。私有音频保留在 `turbo-smoke/` 和 `hd-canary/` 运行目录；脱敏 Golden Fixture 不复制音频：

```text
minimax-canary-output/
├─ turbo-smoke/                         # 私有运行产物，含音频
├─ hd-canary/                           # 私有运行产物，含音频
├─ production-canary-report.json
└─ fixtures/minimax-production-canary/<run-id>/
   ├─ request.redacted.json
   ├─ response.redacted.json
   ├─ response.contract.json
   ├─ provider-subtitles.json
   ├─ local-alignment.json
   ├─ alignment-comparison.json
   ├─ shadow-asr.json
   ├─ audio-manifest.json
   ├─ resolved_timeline.json
   ├─ security-scan.json
   └─ acceptance-report.json
```

工具不会保存 Key、Authorization 或签名下载 URL，也不会为测试限流而主动制造突发请求。完整操作和签收条件见 [`PRODUCTION_CANARY_RUNBOOK.md`](PRODUCTION_CANARY_RUNBOOK.md)。

执行草稿 TTS 和时间求解：

```powershell
node dist/index.js story resolve examples/story-pipeline/risk-story-manifest.json `
  --project C:\path\to\story-project `
  --mode draft `
  --ffmpeg C:\path\to\ffmpeg.exe `
  --aligner C:\path\to\infinite-canvas\tools\local-aligner\.venv\Scripts\local-aligner.exe
```

正式旁白使用 `--mode final`。只主动重生成某一段时使用：

```powershell
node dist/index.js story resolve story_manifest.json --project . --mode final --force VO002
```

只重算对齐而不重新调用 TTS：

```powershell
node dist/index.js story resolve story_manifest.json --project . --mode final --force-alignment VO002
```

同一请求默认分别命中 `cache/tts/<request_hash>/` 和 `cache/alignment/<alignment_hash>/`。`--force` 会重做指定段的 TTS 及下游对齐，`--force-alignment` 只重做 Alignment；旧产物先移入对应缓存目录的 `history/`，不会静默覆盖。

## 本地对齐器契约

`--aligner` 指向 `tools/local-aligner` 的独立进程。Canvas Agent 通过中立 JSON 协议调用：

```text
<aligner> doctor --json
<aligner> align <request.json> <result.json>
```

请求包含绝对音频路径、已知正文、`story-tokenizer/1` 稳定词元、采样区间和设备配置。结果只包含稳定 `token_id` 的整数采样边界、未匹配区间、模型身份和内容哈希。完整协议见 [`../../../tools/local-aligner/README.md`](../../../tools/local-aligner/README.md)。

Provider 和本地对齐器的分词都会映射回 `story-tokenizer/1`。Manifest 中的 `from_token`/`to_token` 因此不依赖 MiniMax 的临时分词结果。

TTS 与 Alignment 缓存完全分离：

```text
TTS Cache Key
= 规范化 TTS 请求

Alignment Cache Key
= 归一化音频哈希
+ 归一化正文哈希
+ 稳定词元协议版本
+ 质量门版本与阈值
+ Provider 时间戳哈希
+ 对齐器后端、模型、revision 与配置
```

因此更换 WhisperX 模型、词元规则或对齐配置不会重新调用 MiniMax。

## 产物

```text
story-project/
├─ resolved_timeline.json
├─ cache/tts/<request_hash>/
│  ├─ request.json
│  ├─ response.json
│  ├─ http_metadata.json
│  ├─ source_44100.wav
│  ├─ normalized_48000_mono.wav
│  ├─ timestamps.provider.json
│  └─ receipt.json
├─ cache/alignment/<alignment_hash>/
│  ├─ request.json
│  ├─ timestamps.resolved.json
│  ├─ alignment_report.json
│  └─ receipt.json
└─ build/story-pipeline/
   ├─ story_manifest.snapshot.json
   ├─ resolve_receipt.json
   └─ audio/
```

`resolved_timeline.json` 的视频事实使用整数帧，音频事实使用 48 kHz 整数采样；秒数仅用于查看。

当前阶段状态见 [`PHASE_STATUS.md`](PHASE_STATUS.md)。
