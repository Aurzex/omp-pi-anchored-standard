# omp-pi-anchored-standard

给 **omp**（Oh My Pi）和 **pi**（pi-coding-agent）使用的 "anchored standard" 插件。核心思路：把目标模型的**第一个请求**锚定到最小工具目录 + DSH 人设，在会话记录到**第一个持久提升信号**后恢复完整工具目录（或可选的 resident 工具集）与正常预算。

**默认零配置可用**：未配置 `anchoredTools` 时自动锚定 `deepseek-v4-pro`，使用纯 anchored-standard 行为（`taskRouting: false`），实测稳定复现 `We need` 风格。任务感知路由（`taskRouting: true`）可选开启，参考 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)。

> 这是 prompt 条件化实验补丁，不是正确性保证；底层评测是单一私人评测，不是普适结论。插件无网络请求、无遥测。

## 为什么存在

DeepSeek V4 Pro 对 API 可见的工具目录高度敏感。Project2 评测（DeepSeek V4 Pro，`reasoningEffort=max`）：

| Preset                | Ability (run1/run2) | `let me` 计数 | 工具目录        |
| --------------------- | ------------------: | ------------: | --------------- |
| Standard              |                  91 |           208 | 完整（25 个）   |
| PTC                   |                  92 |           194 | `run_code`      |
| Minimal               |             99 / 96 |         0 / 0 | 2 个            |
| **Anchored Standard** |         **98 / 99** |     **1 / 0** | 先 2 个，后完整 |

宽工具目录对**首请求**有害（高 `let me`、计划退化），但永久停在 Minimal 会丢掉 Standard 的工具集。因此采用两阶段：

1. **第一个模型请求** → 只暴露首轮核心工具（`bootstrapMode: "two-tool"`，默认），或零工具 + 固定 anchor 回合（`bootstrapMode: "zero"`）。
2. **第一个持久提升信号之后**（按 `promoteOn`）→ 恢复完整目录（默认，能力无损失）；配置 `promotedTools` 后切到上游实测的 post-promotion resident 工具集，避免 25 个工具一次性灌回导致轨迹回退。

## 工作原理

```text
第一请求                          持久提升信号后                 compaction 后
────────────────────             ────────────────────          ────────────────────
two-tool: shell + read           完整目录 / promotedTools       bootstrap 工具 + compactionTools
zero:     空工具 + anchor 回合    完整目录 / promotedTools       空 / shell + compactionTools
```

- 阶段从**持久会话条目**推导（`getBranch()` / `buildContextEntries()`），`/resume`、`/reload` 自动保留。
- 每个锚定阶段**只变一次**（一次 request-prefix cache 断层）。
- compaction 后作为「第二个首请求」重新收窄，直到新的持久提升信号出现。
- 提升决策按会话 id 在进程内记忆；`session_compact` 后重置该会话的 memo（对齐上游 `compaction-epoch.mjs`）。
- 失败的 tool call 也算持久信号 → 提升。

## 安装

当前版本：`omp-pi-anchored-standard@0.12.0`

### omp

```sh
omp plugin install omp-pi-anchored-standard
```

或从仓库安装：

```sh
omp plugin install github:Aurzex/omp-pi-anchored-standard
```

没有 `bun` 时手动拷贝：

```sh
mkdir -p ~/.omp/agent/extensions
cp -r /path/to/omp-pi-anchored-standard ~/.omp/agent/extensions/omp-pi-anchored-standard
```

### pi

```sh
pi install omp-pi-anchored-standard
```

或加入 `~/.pi/agent/settings.json` 的 `packages`：

```jsonc
{ "packages": ["git:github.com/Aurzex/omp-pi-anchored-standard@v0.12.0"] }
```

> 版本锁：git 安装可用 `@v0.12.0`（pi）/ `#v0.12.0`（omp）；npm 安装默认 `latest`（`0.12.0`）。

## 配置

配置统一放在宿主设置里的 `anchoredTools` 顶层键。项目配置深合并覆盖全局：嵌套对象递归合并、**数组整体替换**（不拼接）、项目优先。

| 配置项                     | 类型 / 默认值                                                 | 说明                                                                                 |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `enabled`                  | `boolean` / `true`                                            | 总开关                                                                               |
| `models`                   | `string[]` / `["deepseek-v4-pro"]`                            | 目标模型 glob；含 `/` 只匹配 `provider/modelId`，裸名两种都匹配；`[]` 不锚定任何模型 |
| `bootstrapMode`            | `"two-tool" \| "zero"` / `"two-tool"`                         | 首轮工具面模式                                                                       |
| `bootstrapTools`           | `string[]` / `["bash", "read"]`                               | two-tool 模式首轮工具；`bash`/`pwsh` 按平台 shell 归一化                             |
| `promoteOn`                | `"tool-call" \| "assistant-message" \| "either"` / `"either"` | 持久提升信号                                                                         |
| `minimalSystemPrompt`      | `boolean` / `true`                                            | 系统提示改写为 DSH minimal 人设（永久生效）                                          |
| `bootstrapMaxTokens`       | `number \| undefined` / 不封顶                                | 可选首请求输出预算封顶；**仅 pi 生效**                                               |
| `taskRouting`              | `boolean` / `false`                                           | 任务感知路由，仅 two-tool 模式                                                       |
| `routerMode`               | `"standard" \| "spec"` / `"standard"`                         | `taskRouting: true` 时生效；standard=RL 接口还原，spec=深度思考优先                  |
| `suppressedContextSources` | `string[]` / `["skill-catalog", "agent-instructions"]`        | 首请求剥离的自动注入上下文；`[]` 关闭剥离                                            |
| `compactionTools`          | `string[]` / `[]`                                             | compaction 后、重新提升前的工作集                                                    |
| `promotedTools`            | `string[]` / `[]`                                             | 提升后 resident 工具集；`[]` = 恢复完整目录                                          |
| `includeSubagents`         | `boolean` / `false`                                           | `true` 时子代理也走 bootstrap/anchor 阶段；omp 生效                                  |
| `anchorText`               | `string` / `This round is a test. ...`                        | zero 模式 anchor 文本                                                                |
| `notify`                   | `boolean` / `true`                                            | 提升时一次性 TUI 通知                                                                |

### omp 示例

全局 `~/.omp/agent/config.yml` 或项目 `<项目>/.omp/config.yml`：

```yaml
anchoredTools:
    enabled: true
    models:
        - deepseek-v4-pro
    bootstrapMode: two-tool
    bootstrapTools:
        - bash
        - read
    promoteOn: either
    taskRouting: false
    routerMode: standard
    minimalSystemPrompt: true
    suppressedContextSources:
        - skill-catalog
        - agent-instructions
    compactionTools: []
    promotedTools: []
    includeSubagents: false
    notify: true
```

改完重启 omp。

### pi 示例

全局 `~/.pi/agent/settings.json` + 可信项目的 `.pi/settings.json`：

```jsonc
{
	"anchoredTools": {
		"enabled": true,
		"models": ["deepseek-v4-pro"],
		"bootstrapMode": "two-tool",
		"bootstrapTools": ["bash", "read"],
		"promoteOn": "either",
		"minimalSystemPrompt": true,
		"taskRouting": false,
		"routerMode": "standard",
		"anchorText": "This round is a test. Tools are not open yet; all tools will open next round.",
		"suppressedContextSources": ["skill-catalog", "agent-instructions"],
		"compactionTools": [],
		"promotedTools": [],
		"includeSubagents": false,
		"notify": true,
	},
}
```

改完 `/reload`。

## 行为细节

### `promoteOn`

- `tool-call`：第一个持久 tool call 后提升。
- `assistant-message`：第一个持久 assistant 消息后提升。
- `either`（默认）：两者先到者，纯文本首答也会在下一轮提升。
- zero 模式固定使用 `assistant-message`（anchor 回复），忽略 `promoteOn`。

### `bootstrapTools`

默认 `["bash", "read"]`，对应 modeltest 98/99 分 anchored-standard 快照的 `shell + read`。`bash`/`pwsh` 会按目录里实际存在的平台 shell 归一化（`pwsh` 优先）。若目录存在 `str_replace_editor`，可显式配置 `["bash", "str_replace_editor"]` 复刻上游 Minimal 精确 schema。

### `taskRouting` + `routerMode`

`taskRouting: true` 后，`routerMode` 决定首轮行为：

- `standard`（默认）：RL 接口还原。系统只保留 DSH minimal 人设，工具面为 shell + `str_replace_editor`；目录缺 `str_replace_editor` 时回退到 `bootstrapTools`。
- `spec`：旧版深度思考优先。按任务分类选择 persona 与工具面：
    - `react`（新建/开发）→ doer persona + `read`/`write`/`edit`
    - `spec`（修复/维护）→ minimal persona + `read`/`edit`/`glob`/`grep`
    - `weak`（模糊/无关键词）→ 模型自分类 persona + `read`/`write`/`edit`
    - Flash 模型一律强制 `weak`（w7 + 静态深度思考/决策闭环锚）。

### `suppressedContextSources`

- 首请求剥离自动注入的 AGENTS.md / skill-catalog / workspace 摘要。
- 消息带 `source.kind` 时按来源精确过滤；omp/pi 消息无 `source.kind` 时重建为 `[system, last user]`。
- 含 assistant/toolResult 的多轮历史不重建。
- 显式配置 `[]` 关闭剥离。

### `bootstrapMaxTokens`

- 默认不封顶。上游 issue #11 实测 Minimal 工具 schema 在适配器默认 maxTokens（256000）下即可锚定 `We need` 轨迹。
- 配置后才封顶，提升后剥离注入的上限。
- **仅 pi 生效**。omp 无原生 max-token setter，且 `before_provider_request` 返回值被 openai-completions 传输层丢弃，故 omp 只校验该配置。

### `promotedTools`

- 默认 `[]`：提升后恢复完整目录。
- 非空：提升后只保留指定工具（如 `["bash", "read", "edit", "glob", "grep"]`），复刻上游 post-promotion resident 行为。
- `bash`/`pwsh` 按平台 shell 归一化；缺失时 fail-safe 保持完整目录。

### `includeSubagents`

- 默认 `false`：子代理始终完整目录。
- `true`：omp 子代理（`session_init` 条目）也走 bootstrap/anchor 阶段。
- pi 无 `session_init`，该选项主要对 omp 生效。

### zero 模式

- 首请求工具集置空，并把最后一个 user 消息内容替换为 `anchorText`。
- anchor 回复落库后提升。
- 与上游差异：上游会把真实消息自动推迟到下一轮；本插件无法安全推迟持久化消息，因此 anchor 轮结束后需要用户继续一句，真实消息在后续轮次用完整目录/resident 集回答。
- compaction 后不再注入 anchor；配置 `compactionTools` 则暴露平台 shell + 工作集，否则保持零工具直到新的 assistant 消息。

## 验证

会话里运行：

```sh
/anchored-tools
```

报告当前模型、是否命中目标、模式、任务路由、`routerMode`、提升触发器、当前阶段（`bootstrap` / `promoted (full catalog)` / `promoted (resident catalog)` / `not-targeted` / `disabled`）以及轨迹指纹（`we` / `let's` / `let me`）。

首次锚定与系统提示改写会打日志：

```text
[anchored-tools] anchoring first request for deepseek/deepseek-v4-pro: 2/25 tools (bash, read)                                       # two-tool (default)
[anchored-tools] anchoring first request for deepseek/deepseek-v4-pro: 5/25 tools (read, edit, glob, grep, bash) [task-routing spec]   # two-tool
[anchored-tools] anchoring first request for deepseek/deepseek-v4-pro: 4/25 tools (read, write, edit, bash) [task-routing react]      # two-tool
[anchored-tools] anchoring first request for deepseek/deepseek-v4-flash: 0 tools (zero-tool anchor)                                  # zero
[anchored-tools] deepseek/deepseek-v4-pro: system prompt → route persona (react)                                                     # taskRouting
```

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test（原生 TS，无需 bun；bun 环境同样可跑 node:test）
```

## 目录结构

```text
src/
  core.ts   # 共享纯逻辑：promotion / bootstrap / router / prompt / config
  omp.ts    # omp 入口：setActiveTools + context 注入 anchor + systemPrompt
  pi.ts     # pi 入口：before_provider_request + buildContextEntries
test/
  core.test.ts   # node:test 单测（136 例）
```

## 更新记录

### 0.12.0

- 性能：新增 omp/pi 配置文件按 mtime/size 缓存，避免每次 hook 重复读盘解析。
- 性能：关闭 `taskRouting` 时不再扫描会话/消息做任务分类；glob 正则缓存改为逐条淘汰而不是整表清空。
- 交互：pi 的 `/anchored-tools` 现在与 omp 一致显示实际生效的 bootstrap 工具集及来源（`router` / `configured`）。
- 逻辑：`stripContextMessages` 改为单次遍历并提前返回，保持原语义。

### 0.11.1

- 重写并优化 README：更清晰的结构、完整配置表、安装/验证/限制说明。
- 无功能变更。

### 0.11.0

- 对齐 `dsh-router-standard` v0.2.0/v0.2.1：
    - 新增 `routerMode`（`standard` 默认 / `spec`）。
    - `standard`：RL 接口还原，首轮系统只保留 DSH minimal 人设，工具面为 shell + `str_replace_editor`。
    - `spec`：旧版任务分类 persona + 读/写/编辑工具面。
- omp/pi 双入口的 `taskRouting` 均支持 `routerMode`；`/anchored-tools` 显示当前 `routerMode`。
- 文档与测试同步更新（136 例）。

### 0.10.0

- 对齐上游 `dsh-anchored-standard` 最新版：`promoteOn` 默认改为 `either`。
- 新增 `promotedTools`：提升后可切换到上游 resident 工具集，默认 `[]` 仍恢复完整目录。
- 新增 `includeSubagents`：默认 `false` 豁免子代理；`true` 后 omp 子代理也走 bootstrap/anchor 阶段。
- omp/pi 双入口同步支持上述配置；`/anchored-tools` 增加 `promoted (resident catalog)` 与 `promoted tools` 展示。

### 0.9.0

- 默认对齐 modeltest 98/99 分 anchored-standard 高分开局。
- 支持 omp/pi 双宿主、zero 模式、任务路由、上下文剥离、compaction epoch。

## 已知限制

- omp 用 `setActiveTools` 收窄活动工具集；pi 用 `before_provider_request` payload 过滤。
- omp 的 `before_provider_request` payload 替换对 openai-completions 传输无效，因此 omp 入口不依赖它。
- `bootstrapMode: "zero"` 的 anchor 轮结束后需要用户继续一句，真实消息不自动推迟。
- pi 无 `session_init`，子代理豁免（`includeSubagents: false`）仅 omp 能识别。
- `bootstrapMaxTokens` 默认不封顶且仅 pi 生效。
- `models` 默认 `["deepseek-v4-pro"]`；显式配置 `[]` 可关闭锚定。

## 参考实现

本插件是以下上游实测 preset 的 omp/pi 移植：

| 路径        | Flash                                                                                       | Pro                                                                          |
| ----------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 官方 API    | [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)（dsh-router-standard）  | [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) |
| opencode-go | [v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go) | [myDshPresets](https://github.com/0liveiraaa/myDshPresets)                   |

采纳要点：

- `bootstrapTools` 默认 `["bash", "read"]`，omp/pi 用宿主等价 shell + `read`；存在 `str_replace_editor` 时可显式切回 Minimal 精确 schema。
- `routerMode`（`standard`/`spec`）移植自 dsh-router-standard v0.2.0。
- Flash 在 `taskRouting` 下强制 `weak`，并静态并入 w7 深度思考/决策闭环锚。
- 平台 shell 选择 `pwsh` 优先。
- `compactionTools` / compaction epoch 移植自 `compaction-epoch.mjs`。
- zero 模式与 `suppressedContextSources` 对应 zero-anchored-standard / whoami-standard。

## License

MIT。概念移植自 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)（MIT）、[`yjh051108/dsh-routing-suite`](https://github.com/yjh051108/dsh-routing-suite)（MIT）、[`SheberDavid/v4-flash-godmode-opencode-go`](https://github.com/SheberDavid/v4-flash-godmode-opencode-go)（MIT）与 [`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro)（MIT）。与 DeepSeek / pi 项目无关联，未经其背书。
