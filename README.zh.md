# dsh-context-handoff

> 给 DeepSeek Harness（dsh）用的「带 token 账本」的上下文交接插件：把长会话总结成一份自包含的 Markdown 文件，先算清楚「继续当前会话」和「开新会话」哪个更省 token，再决定什么时候交接。

[English](README.md) · [发布说明](docs/PUBLISHING.md) · [设计说明](docs/DESIGN.md) · [GitHub](https://github.com/idianzi/dsh-context-handoff)

- **`/handoff`**：调用当前模型，把会话总结成一份新会话可以直接读取的交接文件。
- **`/handoff plan`**：不调用模型，用 `ctx.tokenMeter` 的真实测量值比较两条路径的 token 成本，给出盈亏平衡轮数和推荐触发点。
- **侧边栏开关**：右侧栏的「上下文交接」面板里手动开关自动总结，开关按工作区保存。
- **自动模式**：会话空闲且越过推荐点时，自动写交接文件，并创建一个新会话、把续接提示排进新会话。
- **确定性回退**：模型不可用、额度耗尽或请求失败时，仍然可以从会话日志生成一份保守的摘要，不会让 `/handoff` 完全失败。
- **密钥脱敏**：写入前默认擦除常见 API key、GitHub token、私钥等。
- **本地账本**：每次生成都追加一条 JSONL 记录，`/handoff stats` 可以看到累计摘要成本与估算节省。

---

## 为什么不是「再压缩一次」

dsh 自带的 `/compact`（compaction）把较早的历史替换成一条摘要，**继续在同一个会话里工作**。它解决的是「上下文快满了，但我不想离开这个会话」。

`dsh-context-handoff` 解决的是另一个问题：**什么时候值得离开这个会话，带着一份高质量的交接文档重新开始**。这两件事的成本结构不同：

- compaction 的摘要留在会话里，之后每一轮仍然会带着它；它不降低「每轮重发整个前缀」的长期成本。
- handoff 的摘要写到文件里，新会话只读一次（之后进入新会话的缓存前缀），旧会话的 10 万 token 历史不再每轮重发。

所以 handoff 不是越早越好：写得太早，摘要成本还没摊薄，还会丢掉仍然有用的细节；写得太晚，又已经为超长上下文多付了很多轮。插件用下面的模型来回答「什么时候写」。

---

## 安装

### 从插件市场安装

插件上架后，在 **Plugins → Discover** 搜索 `dsh-context-handoff` 安装即可。上架流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

### 从 npm 安装

```sh
dsh plugin --profile web add dsh-context-handoff
```

Desktop 版建议在 **Plugins** 页面安装；如果使用命令，Desktop 的 profile 需要先由应用初始化，并在操作前完全退出 Desktop：

```sh
dsh plugin --profile desktop add dsh-context-handoff
```

安装后重启对应的 dsh 进程（启用 HMR 的 profile 会自动重载）。

### 从本地目录安装（开发）

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-context-handoff
```

### 确认已启用

`package.json` 的 `dsh.profile.bundles` 中应出现 `dsh-context-handoff`。如果手工组合而没有使用 bundle patch，profile 的 `cordis.patch.yml` 需要插入一行：

```yaml
- insert:
    - id: context-handoff
      name: dsh-context-handoff
```

已经由 bundle 安装后再改配置，则按 id 覆盖该行（不要再写一次 `name`/`insert`）：

```yaml
- id: context-handoff
  config:
    recommendAtRatio: 0.7
```

然后在聊天框输入 `/handoff help`。命令只在挂载了 `dsh-commands` 的交互式 UI 中可用；headless/ACP 场景仍可使用自动模式。

---

## 使用

| 命令 | 作用 |
|---|---|
| `/handoff` | 立即生成交接文件，并报告 token 对比。 |
| `/handoff plan [turns]` | 只做成本分析，不调用模型、不写文件。`turns` 是「你预计还会在当前会话里工作多少轮」，默认取配置的 `horizonTurns`。 |
| `/handoff now [tokens]` | 立即生成，并指定摘要的 token 预算（最小 600）。 |
| `/handoff status` | 当前上下文压力 + 最新交接文件。 |
| `/handoff list` | 列出输出目录里最新的交接文件。 |
| `/handoff stats` | 汇总本地 JSONL 账本：摘要成本、估算节省、平均盈亏平衡轮数。 |
| `/handoff auto [on\|off]` | 查看或设置当前工作区的自动总结开关；与侧边栏开关是同一个状态。 |
| `/handoff help` | 帮助。 |

### 侧边栏开关（推荐）

会话标题右边有一个小胶囊：**上下文 545k**（开了自动总结会显示 **自动总结 545k**）。点它就会展开右侧栏并打开「上下文交接」面板，不用先知道右侧栏在哪。

右侧栏里也可以手动打开：右侧栏 → 添加 → **上下文交接**。

- 顶部开关控制「自动总结」。状态保存在当前工作区的 `.dsh/handoff/auto.json`，重启后还在；不同工作区互不影响。
- 面板显示当前上下文、推荐阈值、进度条，以及「只生成文件」和「生成并开新会话」两个按钮。
- 自动模式触发时：先写交接文件，再在当前工作区创建一个新的根会话，把 `Read @...` 的续接提示作为第一条消息排进去。如果你正看着源会话，面板会自动切到新会话；如果不在，面板会给出「打开新会话」按钮。
- 默认 `autoNewSession: true`；不想自动开新会话就把它设为 `false`，自动模式只会写文件。

自动模式只对**当前工作区**生效，并且每个源会话最多自动交接一次；之后想再交接可以手动点按钮或运行 `/handoff`。

### `/handoff plan` 的输出示例

```text
Context: 118k / 128k (92%), 10.0k headroom
Composition: 11.0k fixed prefix + 107k messages
Digest: 3.0k tokens (budget 3.0k)
Per-turn saving: 57.2k tokens (cache factor 0.55) · break-even 1.2 turns
Over 8 turns: saves 388k tokens after paying for the summary

Recommended now: a handoff repays itself in 1.2 turns, and the context is already at 92% of the window.
Recommendation point: 70.4k tokens (55% of window)
Earliest efficient point: 17.2k tokens over 8 turns
Cache assumption: 50% hit, cache-read weight 0.1
```

### 生成的文件

默认写到工作区的 `.dsh/handoff/`，文件名形如 `20261027-193354-ab12cd34-9f2e.md`：

```markdown
---
dsh_handoff: 1
session: "sess_..."
created: "2026-10-27T11:33:54.260Z"
cwd: "/path/to/workspace"
provider: "deepseek-account"
model: "deepseek-flash"
source_tokens: 118402
window_tokens: 128000
fixed_tokens: 11017
budget_tokens: 3000
digest_tokens: 2840
saving_per_turn: 57300
break_even_turns: 1.3
projected_saved_tokens: 391000
generator: "llm"
summary_mode: "replay"
language: "zh"
truncated: false
---
> **在新会话中继续** — 打开这个工作区，然后发送：
> `Read @.dsh/handoff/20261027-193354-ab12cd34-9f2e.md and continue from the "下一步" section.`
>
> 工作目录：`/path/to/workspace`

# 会话交接：...

## 目标
...
## 当前状态
...
## 关键决策
...
## 文件与代码
...
## 验证
...
## 未解决问题
...
## 下一步
...
## 约束与偏好
...
## 重要背景
...
```

推荐的工作流：

1. 长任务进行到一半，`/handoff plan 10` 看是否已经越过推荐点。
2. 需要离开时 `/handoff`，确认文件路径和摘要预算。
3. 新开会话，粘贴文件里的 `Read @...` 那一行。
4. `@` 文件引用会把整份交接文档作为上下文读入；新会话从「下一步」继续。
5. 原会话可以保留作为证据，不一定要删除。

> 输出目录里还会出现 `ledger.jsonl`。它只记录 token 数字、模型名、文件名和会话 id，不记录对话正文。如果不想留下账本，把 `ledger` 设为 `false`。

---

## Token 模型

插件不猜「摘要大概值多少」，而是用 dsh 的 `ctx.tokenMeter`：

- `P`：当前请求压力（`tokenMeter.measure(session).totalTokens`）。
- `S`：新会话也必须承担的系统提示词 + 工具 schema（`totalTokens - surfaceTokens + system`）。
- `D`：交接文件本身的 token 数（用 `tokenMeter.estimateMessage` 计）。
- `H`：比较时看的轮数（`horizonTurns`，默认 8）。
- `a`：缓存因子，`a = (1 - 命中率) + 命中率 × 缓存读取权重`。

两条路径的近似成本：

```text
继续当前会话 H 轮：  H × P × a
写交接 + 新会话 H 轮：P × a + D + 切换开销 + H × (S + D) × a
```

盈亏平衡轮数：

```text
R* = (P × a + D + 切换开销) / ((P - S - D) × a)
```

在 H 轮视角下，值得切换的最小上下文：

```text
P* = (H × (S + D) × a + D + 切换开销) / (a × (H - 1))
```

推荐点还叠加一个**质量阈值**：

```text
qualityAt = min(window × recommendAtRatio, recommendMaxTokens, window - reserve)
recommendedAt = min(max(P*, qualityAt), window - reserve)
```

原因很直接：在 128k 窗口里，18k token 时切换可能已经「更省 token」，但会丢掉大量仍然有用的上下文。默认 `recommendAtRatio = 0.55`、`recommendMaxTokens = 256000`、`reserve = 8192`，所以：

| 窗口 | 推荐点 |
|---|---|
| 32k | 17.6k |
| 64k | 35.2k |
| 128k | 70.4k |
| 200k | 110k |
| 1M | 256k（被绝对上限封顶） |

这就是「合适的上下文长度」：不是固定值，而是窗口比例、绝对上限和当前模型的盈亏点三者取合适的那个。

### 一个具体的账

设 `P = 118k`、`S = 11k`、`D = 3k`、`H = 8`、缓存命中 50%、缓存读取权重 0.1：

```text
a = 0.5 + 0.5 × 0.1 = 0.55
继续 8 轮 ≈ 8 × 118k × 0.55 = 519k
切换 ≈ 118k × 0.55 + 3k + 1.5k + 8 × 14k × 0.55 = 131k
节省 ≈ 388k
```

所以在这个例子里，**大约 1.2 轮之后**摘要成本就摊平了；但推荐点仍然是 70.4k（128k 的 55%）。这就是为什么插件会同时告诉你两个数字，而不是只给一个「省 token」的结论。

### 这些数字的边界

- 单位是**相对 token 成本**，不是账单。dsh 不提供跨提供方的价格表。
- 缓存命中率和缓存读取权重是配置假设；不同提供方的缓存策略不同。
- `tokenMeter` 对 CJK/JSON schema 使用固定启发式，和真实分词器有误差；数字用于决策，不是计费。
- 摘要会丢失细节。交接文件的质量取决于摘要模型和你的提示；关键约束最好在文件里人工补一句。
- 自动模式不会弹系统通知；生成后侧边栏面板会显示最近文件，并在你正看着源会话时切到新会话。

---

## 配置

所有字段都有默认值，可以只覆盖需要的：

```yaml
- id: context-handoff
  config:
    outputDir: .dsh/handoff
    targetDigestTokens: 3000
    recommendAtRatio: 0.55
    recommendMaxTokens: 256000
    horizonTurns: 8
    auto: false
    autoNewSession: true
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `outputDir` | `.dsh/handoff` | 输出目录；相对工作区，也可以写绝对路径。 |
| `targetDigestTokens` | `3000` | 摘要 token 预算上限。 |
| `minDigestTokens` | `700` | 小上下文时的预算下限。 |
| `maxDigestTokens` | `8000` | 绝对上限，`digestRatio` 再大也不会超过它。 |
| `digestRatio` | `0.03` | 按当前上下文比例决定预算，再被 min/target/max 夹住。 |
| `recommendAtRatio` | `0.55` | 质量阈值：窗口的 55%。 |
| `recommendMaxTokens` | `256000` | 推荐点的绝对上限；默认 256k，超大窗口也不会无限等待。设 `0` 可关闭上限。 |
| `horizonTurns` | `8` | 成本比较的轮数；至少 2。 |
| `cacheHitRatio` | `0.5` | 假设后续轮次的缓存命中比例。 |
| `cacheReadWeight` | `0.1` | 缓存读取 token 相对未缓存输入 token 的成本权重。 |
| `switchOverheadTokens` | `1500` | 开新会话的重新定向成本。 |
| `keepFiles` | `20` | 每个输出目录保留的最近文件数；`0` 表示不清理。 |
| `auto` | `false` | 没有 `auto.json` 时，新工作区的默认开关。侧边栏开关会按工作区覆盖它。 |
| `autoNewSession` | `true` | 自动模式触发时创建新会话并排入续接提示；设为 `false` 只写文件。 |
| `autoMinGrowthTokens` | `8000` | 自动模式两次生成之间至少增长多少 token。 |
| `autoCooldownMinutes` | `10` | 自动模式冷却时间。 |
| `provider` / `model` | 空 | 摘要使用的模型；留空则跟随已路由的请求或 agent 选项。两者必须同时设置。 |
| `maxOutputTokens` | `0` | 摘要调用的输出上限；`0` 表示按预算推导。 |
| `language` | `auto` | `auto` / `en` / `zh`。`auto` 根据对话中的 CJK 比例判断。 |
| `includeToolDetails` | `true` | 回退摘要和纯文本转写中是否包含工具名与短参数。 |
| `transcriptBudgetRatio` | `0.7` | 无法逐字回放时，纯文本转写最多占窗口的比例。 |
| `redactSecrets` | `true` | 写文件前擦除常见凭据。 |
| `fallbackDigest` | `true` | 模型失败时写确定性回退摘要。 |
| `ledger` | `true` | 追加 `ledger.jsonl`。 |

### 自动模式

```yaml
config:
  auto: true
  autoMinGrowthTokens: 12000
  autoCooldownMinutes: 15
```

自动模式只在以下条件**同时**满足时触发：

1. 当前工作区的开关是开（侧边栏或 `/handoff auto on`）；
2. agent 进入 `idle`，且不是 subagent；
3. `plan.useful` 为真（摘要 + 固定前缀确实比当前提示词小）；
4. 当前上下文越过了 `recommendedAt`；
5. 这个源会话还没有完成过一次自动交接（一个会话最多自动交接一次）；
6. 输出目录里最近没有别的交接文件，且超过冷却时间。

它不会打断正在进行的轮次：生成通过 `agent.runMaintenance()` 运行，和 `/compact` 一样是空闲期维护操作。写完后会在同一工作区创建一个新的根会话，并把续接提示排进去；如果创建失败，文件仍然保留，面板会显示错误。

---

## 与 `/compact` 的关系

| | `/compact` | `/handoff` |
|---|---|---|
| 目的 | 继续当前会话 | 开新会话 |
| 结果 | 会话内一条摘要替换旧历史 | 工作区里一份 Markdown 文件 |
| 成本 | 一次模型调用 | 一次模型调用 + 文件读写 |
| 何时用 | 上下文快满，但还要在这个会话里继续 | 任务阶段结束、要换会话、想保留一份可审阅的交接 |
| 是否互相排斥 | 不。可以先 `/handoff`，再 `/compact` | 不。 |

如果上下文已经接近窗口上限，先 `/handoff` 再开新会话通常比连续 compaction 更干净；如果只是想把当前会话再撑几轮，`/compact` 更合适。

---

## 隐私与安全

- 交接文件包含对话正文、文件路径、命令和可能的错误信息。它写在你的工作区里，**默认不要提交到 git**；建议把 `.dsh/handoff/` 加入 `.gitignore`。
- `redactSecrets` 是尽力而为的正则脱敏，不是安全边界。真正的密钥不应该出现在对话里；如果出现过，生成后请人工检查文件。
- 摘要调用会把会话前缀发给当前配置的模型提供方，和正常对话的隐私边界相同。
- `ledger.jsonl` 只记录元数据，不记录正文；但仍包含会话 id 和文件路径。
- 自动模式会在后台产生模型调用、文件和新会话；如果你按 token 计费，请先确认成本可接受。
- 侧边栏开关保存在工作区的 `.dsh/handoff/auto.json`，包含开关和时间，不包含对话内容。

---

## 兼容性

- 已在 **DSH Desktop 0.2.1-rc.3**（`dsh --version` 输出 `0.2.1-rc.3`）验证：bundle 组合、配置 schema 导入、插件加载、`/handoff` 命令注册、Web 启动图包含客户端 bundle、bundle 可由 `/plugins` 正常取回。
- 侧边栏 tab/pane 的注册由客户端 bundle 测试覆盖；命令执行、摘要调用、自动开关、新会话创建和账本逻辑由 `npm test` 用桩服务覆盖。真实模型输出质量和浏览器视觉呈现仍取决于你的 dsh 版本与模型。
- 依赖 `@deepseek-ai/dsh-commands`、`dsh-llm`、`dsh-session`、`dsh-token-meter`、`schemastery` 的 0.2.x API。
- 宿主大版本升级后请重新跑 `npm test`，并用 `--dump-config-schema` 检查 schema 是否仍能导入。

---

## 开发

```sh
cd dsh-context-handoff
npm test              # node:test，40 个测试
npm run check         # 语法检查
npm run pack:check    # 检查 npm 包内容
```

目录结构：

```text
lib/config.js      配置 schema 与交叉校验
lib/economics.js   成本模型、盈亏平衡、推荐点
lib/digest.js      转写、预算裁剪、回退摘要、脱敏、文件渲染
lib/summarize.js   模型调用（前缀回放 / 纯文本回退）
lib/files.js       原子写入、列表、清理、账本
lib/format.js      命令输出
lib/index.js       插件入口、/handoff、HTTP 桥、自动模式
lib/client.js      侧边栏面板（无需构建，CJS 客户端 bundle）
lib/auto-state.js  按工作区保存自动开关
lib/http.js        侧边栏 HTTP 路由的 JSON/同源校验
```

设计取舍和边界见 [docs/DESIGN.md](docs/DESIGN.md)。

## 发布

见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。简单说：

1. 补上 `package.json` 的 `repository` / `homepage` / `bugs`；
2. `npm publish`；
3. 到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 加入目录，市场会自动收录；
4. 在 DSH 的 **Plugins → Discover** 里用索引源验证安装。

## License

MIT
