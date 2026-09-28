# Infinite Canvas Demo 资产备份清单

## 备份范围

本备份只覆盖当前线程中已能从本地项目核验的 Infinite Canvas Demo 资产，不包含 `outputs/` 下其他无关项目，也不包含任何 API Key、token、`.env` 或私密配置。

| 资产组 | 路径 | 文件数 | 大小 | 用途 |
|---|---|---:|---:|---|
| Florae Noctis 系列 | `outputs/florae-noctis-series` | 4 | 8,817,452 bytes | 早期四张系列成片 |
| Florae Noctis 完整 Demo | `outputs/florae-noctis-perfume-demo-2026-07-14` | 18 | 140,721,797 bytes | 源图、4x 中间图、2x 交付图、日志、复盘 |
| 青岚早期成片 | `outputs/qinglan-brand` | 3 | 5,791,695 bytes | 早期品牌物料成片 |
| 青岚完整 Demo | `outputs/qinglan-brand-demo-2026-07-14` | 33 | 300,936,904 bytes | 8 张单品、1 张宽幅主视觉、超分和质检 |
| 超现实梦境原图 | `outputs/surreal-dream-storyboard` | 8 | 15,977,408 bytes | 8 镜头原始分镜 |
| 超现实梦境 2x | `outputs/surreal-dream-storyboard-upscaled-x2` | 8 | 48,069,326 bytes | 8 镜头超分交付图 |
| 女孩与巨熊完整超分 | `outputs/girl-bear-nordic-storybook-upscaled-x2` | 39 | 273,984,120 bytes | 源图、4x 中间图、2x 交付、日志和质量报告 |
| **合计** | 以上 7 组 | **113** | **794,298,702 bytes** | 上传准备范围 |

## 建议上传目录

```text
Infinite-Canvas-Demo-Experiments-2026-09-28/
├── 00_manifest/
│   ├── infinite-canvas-demo-experiments-2026-09-28.md
│   ├── infinite-canvas-assets-backup-manifest-2026-09-28.md
│   └── files-sha256.csv
├── 01_florae-noctis/
├── 02_qinglan-brand/
├── 03_surreal-dream-storyboard/
└── 04_girl-bear-nordic-storybook/
```

## 本地备份包

- 上传准备目录：`C:\Users\Admin\Documents\Codex\2026-07-09\tapnow\deliverables\Infinite-Canvas-Demo-Experiments-2026-09-28`
- 压缩包：`C:\Users\Admin\Documents\Codex\2026-07-09\tapnow\deliverables\Infinite-Canvas-Demo-Experiments-2026-09-28.zip`
- 文件校验：同目录 `00_manifest/files-sha256.csv`。
- 压缩包校验：同目录 `package-sha256.txt`。

压缩包不是 GitHub 代码的一部分，后续应作为整体上传到百度云盘；上传完成后，把百度云盘目录 URL、上传时间和压缩包 SHA-256 回填到 Notion 页面。

## 文件级校验

`files-sha256.csv` 使用 SHA-256 记录每个备份文件的相对路径、字节数和摘要。对外迁移时先校验压缩包，再按需校验单文件。

## 安全检查

- 不备份 `.env`、API Key、Bearer token、Cookie、私钥或本机凭据。
- 不把 `blob:` URL 写入长期清单。
- 只记录相对路径和必要的源图映射；外部 Bridge 的临时绝对路径不作为跨机器依赖。
- GitHub 提交只包含代码、文档和清单，不包含上述二进制资产包。

## 百度云盘状态

本次执行环境的可用工具列表中没有百度云盘 MCP，因此当前只能完成本地整理、清单、压缩包和 Notion 说明，不能声称已经上传到百度云盘。待百度云盘 MCP 暴露后，上传上述压缩包或目录，并在 Notion 中补充远端路径与校验结果。

