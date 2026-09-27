# 人生副本视频流水线（Life-Script Pipeline）

基于开源无限画布 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)（AGPL-3.0）深度定制的「人生副本」短剧自动生产系统。

**基线**：上游 `v0.12.0` + XG 生图 / MiniMax 集成，定制基线提交 `d36c007`，本地分支 `local/xg-v0.12.0`。

## 它做什么

用户丢一个剧本文档（.docx / .txt）+ 可选参考图，交互两段式：

1. 「先给计划」→ Codex 计算预计成片时长、章节结构、场景复用、人物阶段、分镜密度
2. 「开始执行」→ 自动跑完全链路，交付六件套：

| 交付物 | 规格 |
| --- | --- |
| 视频 MP4 | 1920x1080 / 30fps / 无字幕 / 无音轨，静帧稳定展示 |
| 旁白 WAV | 48kHz 单声道，与视频同起点同时长 |
| 字幕 SRT | 简体中文，Netflix 规范（单行≤16字、语义断句、去展示标点） |
| 审核工作台 | `/canvas/<project-id>/review`，时间轴锁定只换图 |
| 封面 | 9:16 竖版，标题「今天你要体验的人生副本是？」+ 剧本人生设定 |
| 发布文案 | ≤20 字标题 + 简介 + 5 个话题 |

## 架构

```text
Codex（操作契约 docs/migration/STORY_PRODUCTION_PLAYBOOK.md）
   │ MCP / Canvas Agent (127.0.0.1:17371)
   ▼
Infinite Canvas Web (127.0.0.1:3000)  ←→  镜头审核工作台
   ├─ XG 生图 (127.0.0.1:18080)    gpt-image-2 · 并发 6 · 多参考图
   ├─ MiniMax TTS                  speech-2.8-hd · Radio_Host 音色 · speed 0.98
   ├─ tools/local-aligner          WhisperX 本地强制对齐（48kHz 整数采样）
   ├─ tools/subtitle-runtime       jieba 语义断句
   └─ tools/media-runtime + story-runtime   FFmpeg 7.1 时间轴锁定合成
```

核心设计约束：

- 时间基准 = 48kHz 整数 sample + 30fps 整数 frame，锁定后换图不改时长
- TTS 缓存与 Alignment 缓存分离；Provider 时间戳过质量门，异常切本地强制对齐
- 生图并发 6（XG 限流前不得自动降）；对齐并发 1（与生图并发互不相干）
- 失败只重试失败项；所有中间产物入项目目录（`outputs/<project-id>/`，已 gitignore）

## 目录

```text
canvas-agent/src/story-pipeline/   分镜规划、Tokenization、MiniMax TTS、时间线
canvas-agent/src/story-review/     镜头审核工作台后端
web/src/pages/canvas/review.tsx    审核工作台前端
tools/local-aligner/               WhisperX 对齐器（Python 3.11 + uv，.venv 不入库）
tools/subtitle-runtime/            jieba 断句（vendored）
tools/media-runtime/               imageio-ffmpeg 二进制（vendored）
tools/story-runtime/               build/verify final deliverables
tools/rebirth-story/               rebirth 项目构建
docs/migration/                    迁移包文档与安装脚本（权威操作契约）
docs/research/                     选型调研、对标账号逐帧拆解
docs/write-life-script/            剧本写稿技能（配套 Codex skill）
```

## 快速开始（新机器）

按 `docs/migration/README.md` 的顺序执行（Doctor → Install-Workflow → Initialize-Environment → Register-CodexMcp → Test-Installation）。密钥只走环境变量：`MINIMAX_API_KEY`、`XG_API_KEY`（`web/.env.local`，不入库）。

## 许可

上游为 AGPL-3.0（见 LICENSE），本仓库延续。商业化或公网服务前需单独评估合规。
