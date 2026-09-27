# 迁移契约

## 必须迁移

- 故事流水线 TypeScript 源码与测试。
- Story Review 后端、前端页面与测试。
- WhisperX 本地对齐器源码、锁定文件和模型锁。
- 字幕运行依赖与 FFmpeg 运行时。
- Codex 故事生产操作手册。
- 项目模板、验收说明和环境检查脚本。

## 新电脑重新生成

- `node_modules`。
- Python `.venv`。
- Canvas Agent Token 和本机配置。
- Codex MCP 注册。
- 新电脑绝对路径和服务进程文件。
- XG 与 MiniMax 的凭据配置。

## 可选迁移

- 指定项目的完整 `outputs/<project-id>`。
- Hugging Face / WhisperX 模型缓存。
- 旧画布导出的 `.canvas.zip`。
- 已交付视频、音频、字幕和封面。

## 禁止迁移

- API Key、Authorization Header、Cookie、访问令牌。
- 浏览器完整用户目录。
- 带临时签名的 Provider 下载 URL。
- 旧电脑上的 Windows Junction/Symbolic Link。
- 无法确认来源的临时文件和调试日志。

## 兼容性要求

迁移包基于提交 `d36c00786c20946475a06bc200945de66ad1d50a`。目标仓库如果不是该提交或其后代，安装脚本必须停止并要求 Codex先进行代码合并评估，不能强行覆盖。

目标仓库已有未提交修改时，安装器会创建备份；如果补丁不能干净应用，则停止安装并保留备份。

