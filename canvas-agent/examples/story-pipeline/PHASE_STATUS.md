# Story Pipeline 阶段状态

## 当前状态

```text
Phase 1: Engineering Complete
Phase 1.5A Local Alignment Acceptance: Passed
Phase 1.5B MiniMax Production Canary: Pending Credentials
Phase 2: Not Started
```

Phase 1 已通过协议、独立 TTS/Alignment 缓存、恢复、时间戳回退、选择性失效、实际 FFmpeg 重采样和安全脱敏测试。

## 本地对齐验收

2026-07-31 已在本机完成：

- Python 3.11.15、WhisperX 3.8.6、PyTorch 2.8.0 + CUDA 12.8。
- NVIDIA GeForce RTX 5060 被隔离环境识别。
- 固定 revision 的中文声学模型可下载、缓存并在 CUDA 上加载。
- 13.42 秒已知中文 WAV 覆盖标点、数字、英文缩写、多音字、控制标签和首尾静音。
- 34/34 稳定词元完成整数采样对齐，未匹配区间为 0。
- 连续两次对齐结果完全一致。
- faster-whisper 影子 ASR 成功运行，文本相似度为 0.9348，仅作为诊断。
- TypeScript 通过独立进程协议触发 WhisperX；破坏 Provider 字幕后正确选择 `local_forced_alignment`，质量分 1.0，第二次命中 Alignment Cache。
- Canvas Agent 自动测试 33/33、Local Aligner 测试 6/6 通过。

机器无关的验收摘要见 [`offline-alignment-acceptance.json`](offline-alignment-acceptance.json)。

## 剩余真实验收

Phase 1.5B 只在以下条件全部满足后执行真实请求：

- 已撤销曾经暴露的旧 MiniMax Key。
- `MINIMAX_API_KEY` 注入一把新的 TTS 专用 Key。
- Canary Manifest 使用实际 `voice_id`。
- `FFMPEG_PATH` 与 `STORY_ALIGNER_EXECUTABLE` 已配置。

真实验收通过标准：

- 先执行约 10 秒 `speech-2.8-turbo` 鉴权烟雾测试。
- 再执行约 31.5 秒 `speech-2.8-hd` 正式 Canary。
- 首轮强制调用 Provider，第二轮 TTS 和 Alignment 均命中缓存。
- 两轮 `resolved_timeline.json` 哈希完全一致。
- 源 WAV、48 kHz 单声道 WAV、三类哈希和 Receipt 齐全。
- `trace_id`、HTTP 状态和可用的限流/用量字段完成脱敏归档。
- Provider 时间戳通过质量门，或本地强制对齐稳定接管。
- Provider 与本地对齐完成词元级差异报告。
- Golden Fixture 安全扫描中不存在 Key、Authorization、Bearer Token 或签名 URL。

在 `acceptance-report.json` 显示 `production_acceptance_passed` 前，不进入 Hyperframes、Kinocut 或 OTIO 实现。正式执行步骤见 [`PRODUCTION_CANARY_RUNBOOK.md`](PRODUCTION_CANARY_RUNBOOK.md)。
