# Docker 验证记录

## 验证环境与边界

本次针对 Windows Docker Desktop 的 Linux/amd64 容器执行验证。外部 XG 使用本地替身，不调用真实生图；不使用实际 MiniMax Key，也不触发真实 TTS 计费。

## 已完成

- CPU、GPU、旧 local 文件入口和集成测试覆盖文件的 Compose 配置解析通过。
- Web Docker 镜像构建通过，Nginx 模板实际加载及配置检查通过。
- Canvas Agent TypeScript 构建通过。
- 现有 Agent 测试 36/36 通过，包括真实 FFmpeg 重采样测试，无跳过项。
- Web TypeScript 类型检查通过。
- 本地对齐器 Python 测试 6/6 通过。
- README 本地文档链接检查通过；本次变更未包含实际 API Key 或账户凭据。

## 容器集成验收

- CPU Agent 镜像实际构建通过，Web、Agent、XG 测试替身健康检查通过。
- Agent 以非 root 用户运行，工作目录正确指向 `/workspace`，Docker 工作流规则可读取。
- 静态网页与审核页深层路由、Agent token 校验、SSE 连接通过。
- 参考图上传、人工换图、版本记录及固定时间轴通过。
- 审核图片以及视频、音频、字幕的实际 HTTP 下载通过，下载内容哈希与导出 Receipt 一致。
- 实际编码 30 帧 1920x1080 静音 MP4，不含音频流或字幕流；独立 WAV 48 kHz 单声道、48000 个采样，哈希保持不变；SRT 展示标点清理通过。
- XG 替身通过 Nginx 收到服务端 Bearer 鉴权，模型查询和 PNG 下载成功；测试 Key 不在前端运行配置中。
- 强制重建全部测试容器后，原项目、选中图片版本、用户参考、导出记录和 Agent token 保持不变。
- 容器内 `local-aligner doctor --device cpu --json` 返回 `ready=true`；WhisperX alignment、音频加载与 faster-whisper 的真实 Python 导入通过。
- 容器 Codex CLI 0.145.0 可运行，设备码登录参数存在；本次未登录真实账户。

测试使用独立 Compose 项目 `life-script-smoke` 和宿主机测试端口，未修改原生 Web/Agent 的配置或历史作品。

## 目标机器仍需验收

- 使用新电脑的 XG 和 MiniMax 凭据完成一条 10～15 秒短稿。
- 容器 Codex 账户登录与真实 Agent 对话。
- WhisperX 模型下载、CPU/CUDA 实际对齐及具体 NVIDIA 驱动兼容性。
- 另一台电脑的浏览器画布导入与局域网访问。
- Apple Silicon 的 amd64 模拟运行；尚未宣称支持原生 arm64 对齐镜像。

## 构建中解决的问题

基础系统的旧 pip 无法正确解析 PyTorch wheel 源的依赖元数据。对齐环境固定使用 pip 25.2 安装 CPU/CUDA Torch，再用 uv 和从既有 uv.lock 提取的核心版本约束安装 WhisperX，避免安装过程漂移到不匹配的 Transformers 主版本。媒体和对齐依赖保持独立虚拟环境。
