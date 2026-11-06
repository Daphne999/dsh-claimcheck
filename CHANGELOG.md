# Changelog

## 0.1.2 — 2026-11-06

- 指纹忽略路径：默认跳过 `.dsh-meow/`，新增 `ignorePaths` 配置（替换默认值），git 与非 git 指纹都生效。
  修的是「记忆库/分析产物每轮变化 → 证据被判旧 → 回合结束反复提醒」的噪声。
- `claim_verify` 产出的证据版本号跟到 0.1.2。

## 0.1.1 — 2026-11-04

- 修复 `agent.followup` 缺 `id`/`role` 导致会话记录损坏的问题（GitHub issue #1）。

## 0.1.0 — 2026-11-01

首个公开版本。

- `claim_plan` / `claim_verify` / `claim_status` / `claim_report` 四个工具。
- 检查类型：`command`（插件执行并校验退出码）、`file`（存在/包含/正则）、`manual`（显式人工确认，永不自动通过）。
- 工作区指纹：git（HEAD + `git status --porcelain -z`）或非 git 目录的有界文件扫描；指纹变化即证据过期。
- 证据：`dsh-claimcheck/evidence@1`，内容 digest、逐条输出摘要与截断标记，落在 `.dsh/claimcheck/`。
- 完成闸门：`agent/turn-stopping` 上检测"有改动但无新鲜证据"，有界提醒，`warn` / `strict` / `off` 三档。
- 自动发现：`package.json` 脚本、pytest、cargo、go。
- 安全：红线命令拒绝、越界路径拒绝、沿用宿主 shell 沙箱。
- 测试：33 项单元/集成测试 + 端到端 smoke。
