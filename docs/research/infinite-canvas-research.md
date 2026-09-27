# Infinite Canvas 调研报告

调研对象：`basketikun/infinite-canvas`

调研时间：2026-07-09

本地仓库：`C:\Users\Admin\Documents\Codex\2026-07-09\tapnow\work\infinite-canvas`

当前源码状态：

- HEAD：`ec0e8c4e24320f945e60e57c24fe4295c04eb2d1`
- 最近 tag：`v0.6.0`
- `VERSION`：`v0.6.0`
- 前端源码：106 个 TS/TSX 文件，约 19126 行
- Canvas Agent：9 个 TS 文件，约 1050 行

## 结论

`infinite-canvas` 适合作为我们“AI 漫剧导演台”的第一阶段前端底座，但不应直接把它现有的前台直连模型接口当成最终架构。最合理的路线是：

```text
Infinite Canvas Web
  -> 我们的 AI Gateway / K8s Job API
      -> Image Tool API
      -> ComfyUI / Wan2.2 / Wan-Animate
      -> Real-CUGAN / RIFE / ffmpeg
      -> review.csv / canvas_graph.json / 知识库
```

它最有价值的资产是：

- 无限画布节点、连线、配置节点和生成回填体验已经成型。
- 数据模型足够简单，便于映射到我们的 `canvas_graph.json`、`shots.json`、`characters.json`。
- 生成链路集中在少数 API adapter 文件里，适合替换为我们的 AI Gateway。
- Canvas Agent / MCP / Codex 插件已经实现，后面可用于让 Codex 自动排分镜、创建生成流程、触发生成。

主要风险是：

- 当前 `main` 比 `v0.6.0` 多了 Unreleased 的 Group 节点改动，前端 `bun run typecheck` 失败。
- 项目定位是个人/本地工具，状态持久化主要在浏览器 IndexedDB/localForage，不适合作为多人协作或公网 SaaS 后端。
- AGPL-3.0 许可需要在商业化或公网服务前单独评估。

## 项目结构

```text
infinite-canvas/
  web/                  Vite + React 前端，核心画布和生成逻辑
  canvas-agent/         本地 Agent，连接网页画布、Codex app-server 和 MCP
  plugins/infinite-canvas/
                        Codex App 插件，注册 MCP 和画布技能
  docs/content/docs/    项目文档，包括数据结构、功能、Agent 接入规划
  Dockerfile            构建 Vite 静态前端，用 nginx 托管
```

前端技术栈：

- Vite 7
- React 19
- React Router 7
- Zustand
- Ant Design 6
- localForage / IndexedDB
- axios / fetch
- fflate / file-saver

后端情况：

- 当前版本没有应用后端。
- Docker 镜像只是 nginx 静态托管。
- AI 请求由浏览器直接请求用户配置的 Base URL / API Key。

## 核心数据模型

核心类型在 `web/src/types/canvas.ts`。

节点类型：

```ts
CanvasNodeType = "image" | "text" | "config" | "video" | "audio" | "group"
```

项目结构：

```ts
CanvasProject = {
  id;
  title;
  createdAt;
  updatedAt;
  nodes;
  connections;
  chatSessions;
  activeChatId;
  backgroundMode;
  showImageInfo;
  viewport;
}
```

节点结构：

```ts
CanvasNodeData = {
  id;
  type;
  title;
  position;
  width;
  height;
  metadata;
}
```

连线结构：

```ts
CanvasConnection = {
  id;
  fromNodeId;
  toNodeId;
}
```

对我们有用的 metadata 字段：

- `prompt`
- `composerContent`
- `generationMode`
- `generationType`
- `model`
- `size`
- `quality`
- `count`
- `seconds`
- `vquality`
- `references`
- `storageKey`
- `mimeType`
- `bytes`
- `durationMs`
- `groupId`
- `status`
- `errorDetails`

这套结构可以直接映射为：

- `canvas_graph.json`：完整节点、边、视口、媒体索引。
- `shots.json`：从 config/text/video/image 节点及其边抽取 shot DAG。
- `characters.json`：把角色节点、参考图节点、标签约束抽为角色资产。
- `review.csv`：根据生成节点的状态、输出路径、错误、人工评分扩展。

## 存储方式

文档 `docs/content/docs/backend/canvas-data-structure.mdx` 和源码确认：

- 画布项目 JSON：localForage，key 为 `infinite-canvas:canvas_store`
- 素材 JSON：localForage，key 为 `infinite-canvas:asset_store`
- 图片 Blob：localForage storeName `image_files`
- 视频/音频 Blob：localForage storeName `media_files`
- 视频生成日志：localForage storeName `video_generation_logs`

关键点：

- JSON 不长期保存大 base64。
- 节点里 `content` 通常是当前会话的 `blob:` URL，不适合作为长期标识。
- 长期标识是 `storageKey`。
- 导出时会打 zip，包含 `projects.json` 和媒体文件。

对我们的启发：

- PoC 阶段可复用它的 zip/export。
- 正式接入时应增加服务端资产 registry，把 `storageKey` 映射到本地文件路径、对象存储 URL 或 K8s PVC 路径。
- 不要依赖浏览器 `blob:` URL 进入生产流水线。

## AI 生成链路

核心入口在 `web/src/pages/canvas/project.tsx` 的 `handleGenerateNode`。

流程：

1. 根据当前节点和上游连线构造生成上下文。
2. 上游文本合并进 prompt。
3. 上游图片/视频/音频转为 reference。
4. 根据 `generationMode` 分发：
   - image：`requestGeneration` 或 `requestEdit`
   - text：`requestImageQuestion`
   - video：`requestVideoGeneration`
   - audio：`requestAudioGeneration`
5. 成功后上传到本地 Blob store。
6. 创建或更新画布节点，并建立连线。

API adapter 文件：

- `web/src/services/api/image.ts`
  - `/v1/images/generations`
  - `/v1/images/edits`
  - `/v1/responses`
  - Gemini `generateContent` / `streamGenerateContent`
- `web/src/services/api/video.ts`
  - OpenAI 风格：`POST /v1/videos`、`GET /v1/videos/{id}`、`GET /v1/videos/{id}/content`
  - Seedance / 火山 Agent Plan：`/contents/generations/tasks`
- `web/src/services/api/audio.ts`
  - `/v1/audio/speech`

视频层已经天然分成：

- `createVideoGenerationTask`
- `pollVideoGenerationTask`
- `storeGeneratedVideo`

这对接我们的 K8s Job Queue 很顺：

```text
createVideoGenerationTask -> POST /jobs/video
pollVideoGenerationTask   -> GET /jobs/{job_id}
storeGeneratedVideo       -> 下载/登记 output_url 或本地路径
```

当前画布页里的 `requestVideoGeneration` 会同步轮询直到完成。正式改造时，建议保留任务节点状态，不要阻塞 UI 等到底。

## 配置系统

配置在 `web/src/stores/use-config-store.ts`。

它支持多个模型渠道：

```ts
ModelChannel = {
  id;
  name;
  baseUrl;
  apiKey;
  apiFormat: "openai" | "gemini";
  models;
}
```

模型值格式是：

```text
channelId::modelName
```

有用点：

- 可以新增一个本地渠道：`AI Gateway`
- Base URL 指向我们的服务，例如 `http://127.0.0.1:8787`
- model 填 `wan2.2-i2v`、`comfyui-flux`、`realesrgan` 等

但建议不要把所有内部能力伪装成 OpenAI 模型长期混用。PoC 可以这么做，正式方案应引入更明确的 provider/capability schema。

## Canvas Agent / Codex 插件

Canvas Agent 位于 `canvas-agent/`。

它做三件事：

1. 本机 HTTP/SSE 服务，默认 `127.0.0.1:17371`
2. MCP server，供 Codex/Claude Code 调画布工具
3. Codex app-server bridge，把网页侧边栏消息发给 Codex，并把工具调用回传到画布确认

已有 MCP 工具包括：

- `canvas_get_state`
- `canvas_get_selection`
- `canvas_export_snapshot`
- `canvas_apply_ops`
- `canvas_create_text_node`
- `canvas_create_config_node`
- `canvas_create_generation_flow`
- `canvas_generate_text`
- `canvas_generate_image`
- `canvas_generate_video`
- `canvas_generate_audio`
- `canvas_run_generation`

网页端通过 `CanvasAgentSnapshot` 暴露：

```ts
{
  projectId;
  title;
  nodes;
  connections;
  selectedNodeIds;
  viewport;
}
```

Agent 写操作路径：

```text
Codex MCP call
  -> canvas-agent /api/tools
  -> SSE tool_call
  -> web applyCanvasAgentOps
  -> 用户确认
  -> /canvas/result
  -> MCP result
```

这对我们很关键：

- Codex 能先读完整画布图。
- Codex 能创建分镜文本节点、配置节点和连线。
- Codex 能触发 `run_generation`。
- 网页有二次确认，避免 Agent 直接改坏画布。

## 测试和构建状态

本地检查：

- `web/bun install --frozen-lockfile`：通过
- `canvas-agent/npm install --no-audit --no-fund`：通过
- `canvas-agent/npm run build`：通过
- `web/bun run typecheck`：失败

前端 typecheck 失败：

```text
src/pages/canvas/project.tsx(588,82): error TS2367:
This comparison appears to be unintentional because the types
'CanvasNodeType.Image | CanvasNodeType.Config | CanvasNodeType.Video'
and 'CanvasNodeType.Group' have no overlap.
```

原因看起来是当前 `main` 新增 Group 节点后，`createConnectedNode` 的参数类型没有包含 `Group`，但内部又判断了 `type !== CanvasNodeType.Group`。

建议：

- 第一轮实践锁定 `v0.6.0` tag，避免跟随 Unreleased。
- 如果必须基于 main，先修这个类型问题再继续。

## 适配我们系统的建议改造点

### 1. 增加 AI Gateway provider

优先改这里：

- `web/src/services/api/image.ts`
- `web/src/services/api/video.ts`
- `web/src/services/api/audio.ts`
- `web/src/stores/use-config-store.ts`

PoC 方式：

- 先把 AI Gateway 做成 OpenAI-compatible。
- `image.ts` 走 `/v1/images/generations` 和 `/v1/images/edits`。
- `video.ts` 走 `/v1/videos`、`/v1/videos/{id}`、`/v1/videos/{id}/content`。

更稳的正式方式：

- 新增 `apiFormat: "director-gateway"`。
- 明确接口：
  - `POST /api/jobs/image`
  - `POST /api/jobs/video`
  - `GET /api/jobs/{id}`
  - `GET /api/assets/{id}`
  - `POST /api/assets`

### 2. 把 canvas graph 导出为我们的规范

当前 export 是 zip + `projects.json`。建议新增：

- `exportDirectorProject(project)`：
  - `canvas_graph.json`
  - `shots.json`
  - `characters.json`
  - `assets/`
  - `review.csv`

优先改：

- `web/src/lib/canvas/canvas-export.ts`
- `web/src/types/canvas-export.ts`

### 3. 给节点 metadata 增加导演台字段

可以先非侵入式加到 `metadata`：

```ts
metadata: {
  shotId;
  sceneId;
  characterIds;
  assetRole;
  jobId;
  outputPath;
  reviewStatus;
  score;
  notes;
}
```

不要第一步就改核心类型太重。先利用 metadata 的开放性做映射。

### 4. 视频生成改为更显式异步

当前 `requestVideoGeneration` 会内部轮询。我们需要：

- 提交 job 后立即回填 `jobId`
- 节点状态为 `loading`
- 后台或用户触发轮询
- 完成后写入 `outputPath` / `storageKey` / `content`
- 失败后写 `errorDetails`

可复用 `web/src/pages/video/index.tsx` 里的日志恢复逻辑，它已经支持保存 task 并恢复 pending log。

### 5. Agent 工具扩展

现有工具能做通用生成，但对导演台还不够。后续可以在 `canvas-agent/src/schemas.ts` 增加：

- `canvas_create_storyboard`
- `canvas_tag_shot`
- `canvas_export_director_graph`
- `canvas_run_pipeline`
- `canvas_review_outputs`

第一阶段不建议加太多；先用现有 `canvas_create_generation_flow` 和 `canvas_run_generation` 证明闭环。

## 第一轮 PoC 路线

建议顺序：

1. 锁定 `v0.6.0` 或修 main typecheck。
2. 本地启动 web，验证新建画布、图片节点、视频节点、配置节点、连线、导入导出。
3. 启动 Canvas Agent，验证 Codex 能：
   - 读取画布
   - 创建文本节点
   - 创建 image/video generation flow
   - 触发生成
4. 做最小 AI Gateway：
   - `POST /v1/images/generations` 返回 mock 图片
   - `POST /v1/videos` 返回 job id
   - `GET /v1/videos/{id}` 返回 pending/completed
   - `GET /v1/videos/{id}/content` 返回 mock mp4 或 URL
5. 把 Infinite Canvas 配置到本地 Gateway。
6. 生成一个小型漫剧分镜图：
   - 角色图节点
   - 场景文本节点
   - shot 配置节点
   - 视频输出节点
7. 导出并转换为：
   - `canvas_graph.json`
   - `shots.json`
   - `review.csv`

## 当前判断

`basketikun/infinite-canvas` 值得进入实践，但第一步应当是“锁版本 + 跑通本地 + mock Gateway”，不要立刻接真实 K8s 和 GPU。

推荐基线：

- 产品/交互参考：`main` 最新功能
- 工程集成基线：`v0.6.0` tag
- 我们的改造原则：少改画布核心，多加 adapter 和 export/import 层

