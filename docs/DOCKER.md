# Docker 部署与迁移

本方案把定制 Web、Canvas Agent、Codex CLI、FFmpeg、PyAV 媒体环境和 WhisperX 对齐器放进容器。XG 生图服务与 MiniMax 仍为外部供应商服务，需要新电脑自行配置有效地址和凭据。画布生产、镜头审核及独立交付契约沿用 [操作手册](migration/STORY_PRODUCTION_PLAYBOOK.md)。

## 服务与数据边界

```text
浏览器 / Codex
    -> Web :3000
        /                 Vite 构建后的画布
        /canvas-agent/*   -> Agent :17371（仍校验 token，支持 SSE）
        /xg-api/*         -> XG_API_BASE_URL（服务端附加 XG Key）

Agent -> MiniMax TTS -> 独立 WhisperX 环境 -> 固定时间轴
      -> /workspace/outputs -> PyAV 导出 -> MP4 + WAV + SRT
```

Agent 内部端口不发布到宿主机。只有 `3000` 或你设置的 Web 端口对外；局域网图片下载、审核与 SSE 都使用浏览器当前访问的 Web 地址。Nginx 不记录带 token 的请求 URL。

| 数据 | 位置 | 保存方式 |
| --- | --- | --- |
| 剧本、参考图、项目中间文件及交付物 | `/workspace/inbox`、`/workspace/outputs` | `workspace` 数据卷 |
| Agent token 与工作区配置 | `/home/canvas/.infinite-canvas` | `agent-config` 数据卷 |
| 容器内 Codex 登录与对话状态 | `/home/canvas/.codex` | `codex-config` 数据卷 |
| Hugging Face 等模型缓存 | `/home/canvas/.cache` | `model-cache` 数据卷 |
| 画布、浏览器素材与浏览器模型配置 | 当前浏览器的本地存储 | 导出/导入 `.canvas.zip`、配置文件 |
| MiniMax、XG 服务凭据 | 本机 `.env` | Compose 运行时注入，不构建进镜像 |

数据卷名称受 Compose 项目名称影响。默认项目前缀为 `life-script-pipeline`；迁移时应维持同一项目名称，或明确恢复到新项目对应的数据卷。

## 前提与配置

需要 Git、Docker Linux 容器和 Compose v2.20+。CPU 版适用于没有 NVIDIA GPU 的电脑；内置 PyTorch/WhisperX 的镜像较大，首次构建和首次模型下载需要网络及数 GB 磁盘空间。镜像默认使用 `linux/amd64`；Apple Silicon 可以模拟运行，但尚未作为原生 arm64 部署验收。

复制根目录 `.env.example` 为 `.env`，配置后执行根目录 README 的启动命令。`.env` 位于本机，不提交 Git。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WEB_BIND_ADDRESS` | `127.0.0.1` | 改为 `0.0.0.0` 允许可信局域网访问 |
| `WEB_PORT` | `3000` | 与现有服务冲突时改为 `3008` 等空闲端口 |
| `XG_API_BASE_URL` | `http://host.docker.internal:18080` | XG 服务根地址，不带末尾 `/` |
| `XG_API_KEY` | 空 | Nginx 为 XG 请求附加的 Bearer Key |
| `MINIMAX_API_KEY` | 空 | Agent 内故事流水线的 MiniMax Key |
| `MINIMAX_API_HOST` | `https://api.minimaxi.com` | MiniMax 服务根地址 |
| `LOCAL_ALIGNER_DEVICE` | `cpu` | GPU 覆盖文件会设为 `cuda` |
| `TORCH_INDEX_URL` | PyTorch CPU wheel 源 | GPU 覆盖文件改为 CUDA 12.8 源；只影响构建 |

XG 与 MiniMax Key 不会写入前端静态资源。网页中原有 MiniMax 直连渠道仍需在网页模型设置中配置，它与 Agent 的 TTS 环境变量配置是两个入口。

如果 XG 在同一宿主机，Windows/macOS 的 Docker Desktop 可使用 `host.docker.internal`；Linux 配置已加入 `host-gateway` 映射，但 XG 必须监听容器可访问的宿主机接口。若 XG 仅监听 Linux 的 `127.0.0.1`，容器通过宿主机网关仍访问不到，需调整 XG 监听地址或使用可访问的服务地址。XG 处于另一台电脑时填写它的局域网地址。容器里的 `127.0.0.1` 只代表该容器自身。

## Agent、Codex 与工作流

获取 token：

```powershell
docker compose exec -T agent node /app/docker/connection-info.mjs
```

网页 Agent 地址使用 `http://localhost:3000/canvas-agent`；远程访问时替换成实际 Web 地址。首次连接不自动导入其他电脑的账户。

首次登录容器 Codex：

```powershell
docker compose exec agent codex login --device-auth
docker compose exec -T agent codex login status
```

登录步骤由用户按终端提示完成，账户状态存在 `codex-config` 卷。若当前账号不提供设备码登录，按 Codex CLI 的登录帮助在受信设备上完成登录，勿在 GitHub、README 或项目 Manifest 中保存登录凭据。

若希望宿主机 Codex 直接控制这个容器，而不使用网页侧栏，可注册本仓库的容器 MCP。以下路径须改成新电脑的克隆目录：

```powershell
codex mcp add infinite-canvas-docker -- docker compose --project-directory "D:/projects/life-script-pipeline" exec -T agent node /app/canvas-agent/dist/index.js mcp
```

这个 MCP 使用容器内部 Agent 配置，不需要在宿主机另装 Node。调用画布工具前，浏览器需要打开画布并连接 Agent。修改宿主机 MCP 后重新加载对应 Codex 会话。

输入与输出使用 Compose 文件复制，不依赖 Windows 目录链接：

```powershell
docker compose cp "D:/scripts/story.docx" agent:/workspace/inbox/story.docx
docker compose cp "D:/references/style.png" agent:/workspace/inbox/style.png
docker compose cp agent:/workspace/outputs/你的项目ID/deliverables ./deliverables
```

容器首次启动会在 `/workspace` 建立 `inbox`、`outputs`、工具与文档入口以及 `AGENTS.md`。重复启动保留已有用户文件，不覆盖手工修改的工作流规则。媒体与对齐 Python 环境相互隔离；旧的 Windows PowerShell 批处理和 Kinocut 实验脚本不作为容器入口。

## NVIDIA GPU

GPU 主机需要可被 Docker 识别的 NVIDIA 驱动；Linux 还需 NVIDIA Container Toolkit，Windows Docker Desktop 需 WSL2 GPU 支持。使用 [Docker 官方 GPU 配置](https://docs.docker.com/compose/how-tos/gpu-support/) 的设备预约方式。

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.gpu.yml exec -T agent local-aligner doctor --json
docker compose -f docker-compose.yml -f docker-compose.gpu.yml exec -T agent local-aligner doctor --load-model --device cuda --json
```

最后一条会下载并加载模型，不发起 MiniMax/XG 计费请求。CUDA 镜像使用 PyTorch 2.8.0 / CUDA 12.8；与具体显卡、驱动的兼容性以目标机 doctor 结果为准。切换回 CPU 时使用不带 GPU 覆盖文件的基础 Compose 并重新创建 Agent。

这里的 GPU 用于本地 WhisperX/影子 ASR 对齐，MP4 默认仍由 CPU/PyAV 编码；XG 生图能力来自已配置的外部服务。生图并发仍遵循生产手册，不与本地对齐并发混为一谈。

## 备份、迁移与升级

源码可从 GitHub 私有仓库克隆。项目文件建议先停止正在运行的任务，再导出工作目录：

```powershell
docker compose cp agent:/workspace/inbox ./backup-inbox
docker compose cp agent:/workspace/outputs ./backup-outputs
```

在新电脑部署完成后，将这些文件复制进新容器：

```powershell
docker compose cp ./backup-inbox/. agent:/workspace/inbox/
docker compose cp ./backup-outputs/. agent:/workspace/outputs/
docker compose exec --user root -T agent chown -R 10001:10001 /workspace/inbox /workspace/outputs
```

历史审核项目主要使用相对路径；若旧 Manifest 中还有旧电脑绝对路径，应先检查并改为新项目内路径，再执行导出。旧版 TTS/Alignment 运行缓存中也可能存在绝对路径，不应把旧缓存视为新机已验收。

画布需要在旧浏览器导出 `.canvas.zip` 后到新浏览器导入。新电脑重新登录 Codex、配置 API 凭据即可继续生产；无需复制全部旧账户状态。如果需要完整灾备，另行备份四个 Docker 卷，并将含登录态的备份按私有文件保管。

```powershell
git pull --ff-only
docker compose up -d --build
```

上述更新保留数据卷。`docker compose down` 只停止服务并移除容器网络；不要在保留数据时加 `-v`。若 GPU 部署需要更新，继续带上同一 GPU 覆盖文件。

## 自检与测试

```powershell
docker compose config --quiet
docker compose exec -T agent local-aligner doctor --device cpu --json
docker compose exec -T agent python -c "import av,numpy,PIL,jieba,requests,docx; print('media ready')"
```

项目自带隔离的 Docker 集成验收，使用本地 XG 替身，不发起真实供应商请求。测试工程使用独立端口和数据卷；请先在当前终端把 `WEB_PORT` 设置为空闲端口，例如 PowerShell 的 `$env:WEB_PORT='3018'`：

```powershell
docker compose -p life-script-smoke -f docker-compose.yml -f docker/compose.test.yml up -d --build --wait
docker compose -p life-script-smoke -f docker-compose.yml -f docker/compose.test.yml exec -T agent python /app/docker/smoke-test.py
docker compose -p life-script-smoke -f docker-compose.yml -f docker/compose.test.yml down
```

覆盖网页深层路由、Agent token 校验、SSE、工作目录、人物参考上传、人工换图、固定时间轴、真实 MP4 编码、WAV 哈希保持、SRT 清理、XG 代理鉴权和图片下载。验收结果见 [Docker 验证记录](DOCKER_VALIDATION.md)。新电脑仍需用 10～15 秒短稿验收真实 MiniMax/XG 请求、实际模型加载、Codex 账户与浏览器画布导入。

## 常见问题

- Web 端口占用：调整 `.env` 中 `WEB_PORT`，再次 `up -d`。
- XG 返回 502：检查 `XG_API_BASE_URL`、XG 进程监听及宿主机防火墙；不要填容器内的 localhost。
- Agent 401：重新读取当前容器 token，在网页更新连接；不要沿用旧电脑 token。
- 图片在本机正常、局域网看不到：网页 Agent 地址必须使用访问者能到达的 Web 地址，检查是否仍保存了旧 `127.0.0.1:17371` 或临时 Blob 地址。
- Codex 未登录：在容器执行 `codex login status`；宿主机登录并不代表容器也已登录。
- 模型下载失败：检查 Hugging Face 可达性，保留 `model-cache` 卷后重试，不要重新生成所有 TTS。
- 容器内无法“打开目录”：使用审核台下载或 `docker compose cp`，容器没有宿主机文件管理器。
- Linux 文件权限：运行用户是 UID 10001；默认命名数据卷自动初始化。若改用自定义 bind mount，需自行提供该用户可读写的目录。
