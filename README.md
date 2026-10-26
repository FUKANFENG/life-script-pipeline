# 人生副本 · Infinite Canvas 故事生产工作流

基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 的定制项目。把剧本、画风和人物参考交给 Codex，先确认时长与分镜计划，再通过画布、XG 生图、MiniMax 配音和 WhisperX 对齐制作图文故事。

默认交付：**16:9 静音无字幕 MP4、独立完整 WAV、干净的时间轴 SRT、镜头审核工作台、9:16 封面、发布标题与简介及 5 个话题**。审核台支持携带人物/场景参考重新生成、人工换图和版本回滚，换图保持时间戳不变。

## Docker 快速开始

需要 Git、[Docker Engine / Docker Desktop](https://docs.docker.com/get-started/get-docker/) 和 Docker Compose v2.20+，使用 Linux 容器。无需在宿主机安装 Node、Python、FFmpeg 或 WhisperX。默认构建 CPU 版，包含 Web、Canvas Agent、Codex CLI、音视频运行时及本地对齐器。

仓库为 Private，目标电脑需先完成 GitHub 身份认证并具有仓库读取权限。

```powershell
git clone https://github.com/FUKANFENG/life-script-pipeline.git
cd life-script-pipeline
Copy-Item .env.example .env
```

在 `.env` 中填写本机的 `MINIMAX_API_KEY`、`XG_API_KEY` 和 `XG_API_BASE_URL`，然后启动：

```powershell
docker compose up -d --build
docker compose ps
docker compose exec -T agent node /app/docker/connection-info.mjs
```

打开 **http://localhost:3000**。在右上角 Agent 配置中填 `http://localhost:3000/canvas-agent`，连接 token 使用上一条命令显示的值。首次使用网页里的 Codex 还需在容器内登录：

```powershell
docker compose exec agent codex login --device-auth
```

按终端给出的地址在自己的浏览器完成登录。登录状态保存在独立数据卷中；容器不会自动读取宿主机 Codex 账户。

Linux/macOS 的复制命令可改用 `cp .env.example .env`。默认镜像平台为 x86-64；Apple Silicon 可通过 Docker 的 amd64 模拟运行 CPU 版，速度和依赖兼容性需在目标机验收。

## 提交剧本与取回交付物

```powershell
docker compose cp "D:/scripts/story.docx" agent:/workspace/inbox/story.docx
```

在已连接的画布中告诉 Codex：“读取 `/workspace/inbox/story.docx`，按照故事生产手册先规划时长、场景复用、人物阶段和镜头密度，给我确认。”确认后再开始执行。项目资料保存在 `/workspace/outputs/<project-id>/`。

```powershell
docker compose cp agent:/workspace/outputs/你的项目ID/deliverables ./deliverables
```

审核台也支持分别下载视频、音频和字幕。画布与“我的素材”仍存于浏览器本地；换电脑时须导出/导入 `.canvas.zip`，不会因为部署 Docker 而自动同步。

## NVIDIA GPU 与局域网

有 NVIDIA GPU 并已配置容器 GPU 支持时，使用 CUDA 12.8 版对齐器：

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.gpu.yml exec -T agent local-aligner doctor --json
```

局域网访问：把 `.env` 的 `WEB_BIND_ADDRESS` 改为 `0.0.0.0`，重建服务后使用 `http://部署电脑IP:3000`，Agent 地址对应改为 `http://部署电脑IP:3000/canvas-agent`。外部只需开放 Web 端口；Agent 经同源代理访问。此配置面向个人或可信局域网，未提供多人账户与公网登录。

## 数据与更新

工作目录、Agent token、Codex 登录状态和模型缓存分别保存在四个 Docker 数据卷。`docker compose down` 不删除它们；**`down -v` 会删除数据卷**。旧项目输出、浏览器画布和本机 API 配置需要分别迁移。

```powershell
git pull --ff-only
docker compose up -d --build
```

API Key 只从本机 `.env` 读取，不写入镜像或源码。XG 服务继续由你单独部署；默认地址 `http://host.docker.internal:18080` 指向宿主机，不要在容器中使用 `127.0.0.1` 指代另一台服务。

## 文档

- [Docker 部署、配置、备份、迁移与故障排查](docs/DOCKER.md)
- [故事生产操作手册](docs/migration/STORY_PRODUCTION_PLAYBOOK.md)
- [生产链路与源码目录](PIPELINE.md)
- [镜头审核与替换](docs/content/docs/canvas/shot-review.mdx)
- [旧 Windows 原生迁移方案](docs/migration/README.md)
- [Demo 实验记录](docs/archives/infinite-canvas-demo-experiments-2026-09-28.md)

上游为 AGPL-3.0，本项目保留 [LICENSE](LICENSE) 与原作者归属。
