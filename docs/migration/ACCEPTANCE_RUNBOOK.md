# 新电脑验收流程

## 离线工程验收

1. Web TypeScript 类型检查通过。
2. Web 构建通过。
3. Canvas Agent 测试通过。
4. Canvas Agent 构建通过。
5. Local Aligner Python 测试通过。
6. `local-aligner doctor --load-model --device cuda` 通过。
7. Web UI 和 Canvas Agent 均可启动。
8. `/canvas/<project-id>/review` 可以打开。

## 真实小型验收

使用一篇 10～15 秒中文短稿，生成 3 个镜头：

1. MiniMax 生成旁白并下载。
2. 转换为 48kHz 单声道 WAV。
3. WhisperX 完成时间对齐。
4. 建立 1 个画风参考、1 个人物参考和 1 个场景参考。
5. XG 使用 `gpt-image-2` 生成 3 张 16:9 图片。
6. 在审核工作台为其中一个镜头上传参考图并生成新版本。
7. 选择新版本并导出。
8. 验证 MP4 无音频流和字幕流。
9. 验证 WAV、MP4 和 SRT 起点一致、总时长一致。
10. 验证封面、标题、简介和 5 个话题能够生成。

不要用完整长剧本作为第一次验收，避免在环境问题尚未排除时产生大量真实调用费用。

