# Infinite Canvas 人生剧本工作流迁移包

本迁移包用于把当前电脑上已经验证过的“人生剧本 -> 系列图片 -> 成片交付 -> 镜头审核”工作流安装到另一台 Windows 电脑。

目标操作体验：用户只需要把剧本文档和参考图交给 Codex；Codex 先给出时长与分镜计划，用户确认后自动执行，最终交付视频、音频、字幕、审核工作台、封面和发布文案。

## 给新电脑上的 Codex

如果你是第一次读取本目录，请按以下顺序执行：

1. 阅读本文件。
2. 阅读 `workflow/STORY_PRODUCTION_PLAYBOOK.md`。
3. 阅读 `workflow/MIGRATION_CONTRACT.md`。
4. 运行 `setup/Doctor.ps1` 检查目标 Infinite Canvas 工程。
5. 用户确认后运行 `setup/Install-Workflow.ps1`。
6. 运行 `setup/Initialize-Environment.ps1` 安装和构建依赖。
7. 运行 `setup/Register-CodexMcp.ps1` 注册本地定制版 Canvas Agent。
8. 运行 `setup/Test-Installation.ps1`。
9. 按 `workflow/ACCEPTANCE_RUNBOOK.md` 完成一次小型真实验收。

不要读取、复制或输出旧电脑上的 API Key。新电脑的 XG 生图配置应保留原状；MiniMax Key 只通过新电脑环境变量配置。

## 基线

- Infinite Canvas 基线提交：`d36c00786c20946475a06bc200945de66ad1d50a`
- 基线说明：`v0.12.0 + XG/MiniMax integrations`
- 目标系统：Windows 11、PowerShell、Node.js 18+、Python 3.11、NVIDIA CUDA 环境
- Web UI：默认 `http://127.0.0.1:3000`
- Canvas Agent：默认 `http://127.0.0.1:17371`
- XG 服务：默认 `http://127.0.0.1:18080`

## 新电脑快速安装

在新电脑上解压本目录，然后让 Codex 打开本目录并执行：

```powershell
./setup/Doctor.ps1 -TargetRepo "D:\path\to\infinite-canvas"
./setup/Install-Workflow.ps1 -TargetRepo "D:\path\to\infinite-canvas"
./setup/Initialize-Environment.ps1 -TargetRepo "D:\path\to\infinite-canvas"
./setup/Register-CodexMcp.ps1 -TargetRepo "D:\path\to\infinite-canvas"
./setup/Test-Installation.ps1 -TargetRepo "D:\path\to\infinite-canvas"
```

安装脚本会：

- 检查目标仓库是否包含要求的 XG 基线。
- 应用故事流水线和镜头审核工作台代码。
- 安装工作流说明与项目模板。
- 在目标 `AGENTS.md` 中加入工作流入口，不覆盖原有规则。
- 创建本机配置示例，不写入任何凭据。

## 安装后配置

在新电脑环境变量中设置：

```text
MINIMAX_API_KEY=<仅在新电脑本机配置>
MINIMAX_API_HOST=https://api.minimaxi.com
INFINITE_CANVAS_WORKSPACE=<新电脑 Infinite Canvas 根目录>
STORY_ALIGNER_EXECUTABLE=<根目录>\tools\local-aligner\.venv\Scripts\local-aligner.exe
LOCAL_ALIGNER_DEVICE=cuda
FFMPEG_PATH=<根目录>\tools\media-runtime\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe
STORY_ALIGNMENT_MAX_CONCURRENCY=1
```

XG 并发默认保持 `6`。本地对齐并发与 XG 生图并发是两件事，不要因为对齐器配置而降低 XG 并发。

## 迁移旧项目

工作流迁移和历史项目迁移分开进行：

- 未来只做新项目：不需要复制旧 `outputs`。
- 需要继续审核的项目：完整复制对应 `outputs/<project-id>`。
- 旧画布：在旧电脑导出 `.canvas.zip`，在新电脑导入。
- 不要复制 `web/public/project-deliverables` 等 Windows 目录链接；在新电脑重新建立。

## 安装完成后的正常交互

用户可以直接说：

```text
这是一个新的剧本。先计算预计成片时长，规划章节、场景复用、人物阶段和分镜密度，给我计划确认。
```

确认后说：

```text
开始执行。
```

Codex 必须按照 `workflow/STORY_PRODUCTION_PLAYBOOK.md` 执行，并保留计划、提示词、参考图、请求记录、质检结果、版本和最终交付。

## 目录说明

```text
payload/           工作流源码补丁和新增文件
setup/             Windows 安装、启动、检查脚本
workflow/          Codex 必读操作手册与验收规范
project-template/  新故事项目标准模板
examples/          脱敏后的参考实现和结果结构
checksums/         文件清单与 SHA-256 校验值
```

