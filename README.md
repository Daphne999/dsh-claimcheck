# dsh-claimcheck · 验收取证

> **把"做完了"从一句自称，变成一份可机读、会过期的证据。**

DSH（DeepSeek Harness）插件：由**插件自己**执行项目的验收命令，捕获真实退出码与输出，把结果钉在
当前工作区指纹上，写入带 digest 的证据文件；工作区一变，旧证据**自动过期**。收尾时如果改了东西却拿不出
新鲜证据，插件会把这一轮"拦一下"，提示先取证再宣称完成。

[English summary](#english) · [证据格式](#证据格式) · [配置](#配置) · [设计取舍](#不做什么)

---

## 为什么需要它

现在的 agent 生态里，"已完成"是最便宜的一句话，也是最贵的一次不信任：

| 现状 | 后果 |
| --- | --- |
| 模型说"测试都过了" | 没有人知道它到底跑没跑、跑的是哪份代码 |
| 改完 A 又改了 B | A 的验证结论被静默沿用，其实已经过期 |
| 多个 agent / 多轮会话并行 | 各自的"通过"互相污染，没有锚点 |

现有做法大多停在**软提示**（system prompt 里写"记得跑测试"）或**事后看日志**。dsh-claimcheck 的差别是：
**命令由插件执行，不由模型转述**。模型只能选择跑什么、不能伪造结果；`pass` 必须有真实退出码支撑。

## 它保证什么

1. **执行权在插件。** `command` 类检查通过 DSH 的 shell seam 真正执行，退出码、信号、超时、输出都来自真实进程。
2. **通过不可伪造。** `pass` 要求每个 required 检查实际通过；缺证据是 `incomplete`，**永远不是 pass**。
   人工确认类的检查记为 `unknown`，不会自动折算成通过。
3. **证据会自己过期。** 证据记录工作区指纹（git HEAD + 工作区状态，或非 git 目录的有界文件扫描）。
   指纹一变，`claim_status` 立刻返回 stale。
4. **运行期间被改动 = 不可信。** 如果检查命令自己改了工作区，本次结论降级为 `incomplete` 并说明原因。
5. **可审计。** 证据是普通 JSON，带内容 digest（`artifactDigest` 覆盖除 digest 自身外的全部字段）、
   每个检查的输出摘要与字节数，以及明确的 `outputTruncated` 标记。

## 三个工具

| 工具 | 作用 | 关键行为 |
| --- | --- | --- |
| `claim_plan` | 声明"什么算完成" | 校验检查样式；拒绝危险命令与越界路径；最多 12 条 |
| `claim_verify` | **真正执行**并记录证据 | 无计划时可自动发现项目测试命令；写 `runs/<runId>.json`、`latest.json`、`index.jsonl` |
| `claim_status` | 证据现在还算不算数 | 只读，不执行、不写盘；返回 `fresh` / 过期原因 |
| `claim_report` | 交接用 Markdown | 从最新证据渲染，含 digest 与工作区指纹 |

### 检查类型

```jsonc
// 1) 命令检查：插件执行，要求退出码
{ "id": "unit", "kind": "command", "title": "单元测试通过", "command": "pnpm run test", "timeoutMs": 180000 }
// 2) 文件检查：存在 / 包含文本 / 匹配正则
{ "id": "doc", "kind": "file", "title": "README 更新", "path": "README.md", "contains": "claimcheck" }
// 3) 人工检查：显式需要人，永不自动通过
{ "id": "ux", "kind": "manual", "title": "交互已人工确认", "requirement": "产品负责人签字" }
```

不给检查时，`claim_verify` 会按项目形状自动发现：`package.json` 的 `test/typecheck/lint/build`
（按锁文件选择 pnpm/yarn/bun/npm）、`pytest`、`cargo test`、`go test ./...`。

### 完成闸门

每轮结束时，如果这一轮**产生了文件变更**（`write`/`edit`，或写文件、移动、删除、装依赖、带 `--write/--fix`
的 shell 命令）而当前没有新鲜证据，插件会向该会话注入一条提醒并让这一轮继续（`agent.followup`）。

- `warn`（默认）：提醒 + 留出继续取证的机会；
- `strict`：同样的机制，用于"不接受无证据收尾"的场景；
- `off`：完全关闭；
- 提醒有上限（`maxNudgesPerSession`，默认 3），且同一状态不会重复提醒；纯问答轮、只读轮不会触发。

> 诚实说明：插件层能做的是**显著提高伪造成本 + 让结果可审计**，不是密码学意义上的不可伪造。
> 人可以运行任意命令；插件保证的是"每份证据都指向它实际跑过的那次执行和那棵树"。

## 安装

插件是零依赖的 Host-only bundle（无运行时 `@deepseek-ai/*` 导入）。

**方式 A · 市场/桌面端安装页**：搜索 `dsh-claimcheck` 安装。

**方式 B · 命令行**

```bash
git clone https://github.com/<owner>/dsh-claimcheck.git
dsh plugin --profile <profile> add link:"$PWD/dsh-claimcheck"
```

**方式 C · 写进 profile**

```jsonc
// ~/.dsh/profiles/<profile>/package.json
"dependencies": { "dsh-claimcheck": "link:/abs/path/to/dsh-claimcheck" },
"dsh": { "profile": { "bundles": [ /* ... */ "dsh-claimcheck" ] } }
```

装完重启宿主。安装后在插件列表里能看到「Claimcheck 验收取证」，且会话中多出 `claim_*` 四个工具。

## 证据格式

证据写在**会话工作区**下的 `.dsh/claimcheck/`：

```
.dsh/claimcheck/
├── runs/run-mvwkx7ff-qbwqlf.json   # 本次运行的完整证据
├── latest.json                     # 最新一份（原子写入）
└── index.jsonl                     # 追加式索引，一行一条
```

```jsonc
{
  "schema": "dsh-claimcheck/evidence@1",
  "runId": "run-mvwlo6pv-ufq4z4",
  "verdict": "pass",                 // pass | fail | incomplete
  "summary": "all 1 checks passed; required checks have evidence",
  "digest": "c33357…2121",           // 覆盖除 digest 自身外的全部字段
  "workspace": {
    "fingerprint": "f35cb7…98c4",
    "fingerprintSource": "git",      // git | files
    "detail": { "head": "…", "branch": "main", "dirtyFiles": 0 }
  },
  "plan": { "id": "…", "source": "agent|user|discovered", "checks": [/* … */] },
  "counts": { "total": 1, "pass": 1, "fail": 0, "unknown": 0, "error": 0 },
  "checks": [{
    "id": "unit", "kind": "command", "status": "pass",
    "command": "node --test", "exitCode": 0, "signal": null, "timedOut": false,
    "output": "…", "outputDigest": "…", "outputBytes": 1234, "outputTruncated": false,
    "durationMs": 812
  }]
}
```

这个文件不需要装插件也能读：CI、评审脚本、另一个 agent 都能直接消费。

## 配置

写在 profile 的 patch 行里（`cordis.patch.yml`）：

```yaml
- id: dsh-claimcheck
  config:
    mode: warn              # warn | strict | off
    maxNudgesPerSession: 3
    maxOutputBytes: 16384   # 每条检查保存的输出上限
    evidenceDir: .dsh/claimcheck
    autoDiscover: true
    requireGateAfterWrite: true
```

## 安全边界

- **拒绝红线命令**：递归强删、格式化、关机、`curl | sh`、强推/硬重置、`chmod 777 /`、带凭据外传的下载命令等，
  在 `claim_plan`/`claim_verify` 阶段直接拒绝（见 `lib/checks.js` 的 `RED_LINE_PATTERNS`）。
- **路径不越界**：`file` 检查拒绝绝对路径与 `..`。
- **执行沿用 DSH 沙箱**：检查通过 `ctx.shell` 跑，与 shell 工具同一套执行策略。
- **不收集遥测**：插件不联网、不上报；证据只写本地工作区。

## 不做什么

- **不替代测试框架**：它只负责"执行 + 记录 + 过期判定"。
- **不做汇总评分**：没有 score / passRate；只有 pass / fail / incomplete 三态与逐条证据。
- **不评审代码**：质量判断留给人和评审工具。
- **不伪造指纹**：拿不到可靠状态就写文件扫描来源，不编造版本号。

### 与相邻工具的关系

生态里已有 [dsh-acceptance](https://github.com/PolinniZhong/dsh-acceptance)（任务级人工验收台，明确不执行测试）、
[dsh-dod](https://github.com/weft-audit/dsh-dod)（只提醒不拦截）、[dsh-eval-harness](https://github.com/BiBoyang/dsh-eval-harness)
（插件回归评测）。claimcheck 的定位是它们缺的那层：**自己执行、结果绑定工作区、会过期**，
产物是可被上述工具导入的 JSON，而不是又一个看板。

## 开发

```bash
node --test test/*.test.mjs   # 33 项单元/集成测试（含真实子进程）
node scripts/smoke.mjs        # 端到端演示：发现→过期→闸门→修复→通过→交接
```

零运行时依赖；纯 ESM，Node ≥ 22。

## License

[MIT](LICENSE)

---

<a id="english"></a>
## English

**dsh-claimcheck** is a DeepSeek Harness plugin that makes "done" auditable:

- it **runs the project checks itself** through the harness shell seam (real exit codes, bounded output);
- it pins every result to a **workspace fingerprint** and expires the evidence when the tree changes;
- it emits a **digest-addressed JSON artifact** any tool can consume;
- it **holds a turn open** when file-mutating work ends without fresh evidence (bounded, state-aware, never for read-only turns).

Tools: `claim_plan`, `claim_verify`, `claim_status`, `claim_report`. Verdicts are `pass` / `fail` / `incomplete` —
a missing check is never a pass. Zero runtime dependencies, Host-only bundle.

```bash
git clone https://github.com/<owner>/dsh-claimcheck.git
dsh plugin --profile <profile> add link:"$PWD/dsh-claimcheck"
```
