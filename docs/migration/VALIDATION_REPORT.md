# 迁移包验证报告

## 基线

- 源提交：`d36c00786c20946475a06bc200945de66ad1d50a`
- 验证系统：Windows、PowerShell 7、Windows PowerShell 5.1
- 验证日期：2026-08-04

## 已通过

- 在全新克隆的基线仓库中模拟安装通过。
- 重复安装能够识别 `already-applied`，不会重复追加 `AGENTS.md` 规则。
- 所有安装脚本通过 PowerShell 语法解析。
- Canvas Agent：35 项通过、1 项因未设置 FFmpeg 环境变量跳过、0 项失败。
- Canvas Agent TypeScript 构建通过。
- Web TypeScript 类型检查通过。
- Web Vite 生产构建通过。
- Local Aligner：6 项 Python 测试通过。
- Story Media Runtime 能按锁定版本安装，PyAV、NumPy、Pillow、Jieba、Requests 和 python-docx 导入通过。
- 43 个 Python 文件通过 AST 语法解析。
- 迁移包未发现旧电脑工作区绝对路径。
- 迁移包未发现实际 MiniMax Key、Agent Token 或 Authorization 字面值。

## 保留的测试占位值

Story Pipeline 单元测试包含用于验证脱敏逻辑的虚构 `sk-test-*` 字符串。它们不是实际凭据，也不会用于网络请求。

## 尚需在新电脑验收

- 新电脑的真实 MiniMax TTS 请求。
- 新电脑的 WhisperX CUDA 模型加载。
- 新电脑已有 XG 服务的多参考图生图。
- 10～15 秒三镜头真实端到端导出。
- 局域网访问和 Windows 防火墙规则。

