# MiniMax Phase 1.5B Production Canary Runbook

## 基线状态

```text
Phase 1: Engineering Complete
Phase 1.5A Local Alignment Acceptance: Passed
Phase 1.5B MiniMax Production Canary: Pending Credentials
Phase 2: Not Started
```

在本 Runbook 全部通过前，不启动 Hyperframes、Kinocut 或 OTIO。

## 1. 凭据准备

1. 在 MiniMax 控制台撤销此前暴露的旧 Key。
2. 创建只供本项目 TTS Canary 使用的新 Key。
3. 将两个 Canary Manifest 的占位 `voice_id` 替换为真实音色。
4. 不把 Key 写入 `.env`、Manifest、命令参数、日志、测试快照或 Receipt。

在 PowerShell 中通过隐藏输入注入当前进程，输入内容不会进入命令历史：

```powershell
$secureKey = Read-Host 'MiniMax TTS Key' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $env:MINIMAX_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}
```

退出当前 PowerShell 会话后，该环境变量随进程销毁。

## 2. 无计费预检

```powershell
node dist/index.js story canary-preflight examples/story-pipeline/phase-1.5-canary-manifest.json `
  --smoke examples/story-pipeline/phase-1.5-turbo-smoke-manifest.json `
  --project C:\private\minimax-canary-output `
  --ffmpeg $env:FFMPEG_PATH `
  --aligner $env:STORY_ALIGNER_EXECUTABLE
```

必须同时满足：

- Turbo 夹具约 10 秒且使用 `speech-2.8-turbo`。
- HD 夹具约 31.5 秒且使用 `speech-2.8-hd`。
- Key 只来自进程环境。
- 两份 Manifest 均使用真实 `voice_id`。
- FFmpeg 可执行。
- Local Aligner `doctor --json` 返回就绪。

任一 `FAIL` 都不得进入真实请求。

## 3. 受控真实执行

```powershell
node dist/index.js story canary examples/story-pipeline/phase-1.5-canary-manifest.json `
  --smoke examples/story-pipeline/phase-1.5-turbo-smoke-manifest.json `
  --project C:\private\minimax-canary-output `
  --ffmpeg $env:FFMPEG_PATH `
  --aligner $env:STORY_ALIGNER_EXECUTABLE
```

固定顺序：

```text
10 秒 speech-2.8-turbo
→ 身份与 voice_id
→ 临时 URL 立即下载
→ 响应脱敏
→ 44.1 kHz 转 48 kHz
→ 字幕契约解析
→ Turbo 通过
→ 31.5 秒 speech-2.8-hd
→ Provider 时间戳质量门
→ WhisperX 强制回退探针
→ faster-whisper 影子 ASR
→ Provider/Local 差异报告
→ resolved_timeline.json
→ 第二轮缓存复跑
```

Turbo 抛错或检查失败时，程序必须在发起 HD 请求前终止。

## 4. 缓存与计费检查

HD 第二轮必须满足：

- `tts_cache_hit = true`。
- `alignment_cache_hit = true`。
- 不再调用 MiniMax。
- 不重复下载音频或字幕临时 URL。
- 两次 `resolved_timeline.json` SHA-256 完全相同。

`acceptance-report.json` 中应分别出现：

```text
second_run_tts_cache_hit
second_run_alignment_cache_hit
deterministic_timeline
```

## 5. 脱敏 Fixture

私有音频位于：

```text
minimax-canary-output/turbo-smoke/
minimax-canary-output/hd-canary/
```

不要提交这两个目录。可回归的脱敏 Fixture 位于：

```text
minimax-canary-output/fixtures/minimax-production-canary/<run-id>/
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

Fixture 内不得出现 WAV、MP3、Key、Authorization、Bearer Token、真实 `voice_id` 或签名 URL。

## 6. Phase 1.5B 签收

只有以下全部满足才能标记通过：

1. 新专用 Key 和真实 `voice_id` 有效。
2. Turbo 烟雾测试成功。
3. HD 31.5 秒 Canary 成功。
4. 临时 URL 失效前完成下载。
5. 48 kHz 单声道 WAV 采样数重新测量成功。
6. Provider 响应与字幕契约已脱敏归档。
7. Provider 时间戳通过质量门，或 WhisperX 正确接管。
8. Provider/WhisperX 偏差指标完整。
9. faster-whisper 影子 ASR 完成。
10. 第二轮不产生真实请求或重复下载。
11. 安全扫描无敏感信息。
12. 中断恢复由故障注入测试覆盖。
13. `resolved_timeline.json` 稳定复现。

通过后状态改为：

```text
Phase 1.5 MiniMax Production Canary: Passed
Phase 1 Production Accepted
```

## 7. 通过后的冻结动作

1. 保留脱敏 Fixture，私有保存真实音频。
2. 记录真实 MiniMax 模型名和响应契约。
3. 锁定 WhisperX、CUDA、中文模型 revision、Python 和 Node 依赖。
4. 创建 Phase 1 接受提交或标签。
5. 再按以下顺序启动 Phase 2：

```text
Hyperframes 逐镜头编译与缓存
→ Kinocut Assembly
→ OTIO 导出
→ 无限画布内触发和审核界面
```
