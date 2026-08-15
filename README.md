# omp-pi-anchored-standard

给 **omp**(Oh My Pi)和 **pi**(pi-coding-agent)用的 "anchored standard" 插件:把目标模型的**第一个请求**锚定到最小工具目录 + 小输出预算 + DSH 人设,会话记录到**第一个持久提升信号**后恢复完整工具目录与正常预算。**默认零配置可用**:未配置 `anchoredTools` 时自动锚定 `deepseek-v4-pro` 并使用纯 anchored-standard 行为(`taskRouting: false`,实测稳定复现 `We need` 风格);任务感知路由(`taskRouting: true`,参考 [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite))可选开启。

## 为什么存在

DeepSeek V4 Pro 对 API 可见的工具目录高度敏感。Project2 评测(DeepSeek V4 Pro, `reasoningEffort=max`)中:

| Preset                | Ability (run1/run2) | `let me` 计数 | 工具目录       |
| --------------------- | ------------------: | ------------: | -------------- |
| Standard              |                  91 |           208 | 完整 (25 个)   |
| PTC                   |                  92 |           194 | `run_code`     |
| Minimal               |             99 / 96 |         0 / 0 | 2 个           |
| **Anchored Standard** |         **98 / 99** |     **1 / 0** | 先 2 个,后完整 |

也就是:宽工具目录对**首请求**有害(高 `let me`、计划退化),但永久停在 Minimal 会丢掉 Standard 的工具集。两阶段做法:

1. **第一个模型请求** → 只暴露首轮核心工具(`bootstrapMode: "two-tool"`,默认;任务感知路由下按任务类型选 `read`/`write`/`edit`/`glob`/`grep` + shell),或零工具 + 固定 anchor 回合(`bootstrapMode: "zero"`)。
2. **第一个持久提升信号之后**(按 `promoteOn`)→ 恢复完整目录(能力无损失)。

> 这是 prompt 条件化实验补丁,不是正确性保证;底层评测是单一私人评测,不是普适结论。无网络请求、无遥测。

## 行为语义

- **`promoteOn`(默认 `either`)**:`tool-call` = 第一个持久 tool call;`assistant-message` = 第一个持久 assistant 消息;`either` = 两者先到者。默认 `either` 避免"纯文本首答把会话永远困在 bootstrap"(上游的默认选择;pi 移植的 `tool-call` 行为可通过配置恢复)。
- 失败的 tool call 也算持久信号 → 提升。
- 目录每个锚定阶段**只变一次**(一次 request-prefix cache 断层);compaction 后作为「第二个首请求」重新收窄。
- 阶段从**持久会话条目**推导(`getBranch()` / `buildContextEntries()`),`/resume`、`/reload` 自动保留。
- 配置里的 bootstrap 工具名在目录里缺失 → **fail-safe**:跳过过滤并告警,绝不静默剥工具。
- 非目标模型完全不受影响;`models` 默认 `["deepseek-v4-pro"]`(零配置即可用),显式配置 `[]` 才不锚定任何模型。
- 两阶段提升决策按会话 id 在进程内记忆,扫描只做一次;`session_compact` 后重置该会话的 memo(compaction epoch,对齐上游 `compaction-epoch.mjs`)。
- **宿主机制不同**(行为一致):omp 侧通过 `pi.setActiveTools()` 原生收窄/恢复活动工具集(`before_provider_request` 的 payload 替换在 openai-completions 传输层被丢弃,不可靠),zero 模式 anchor 消息经 `context` 事件注入(序列化前生效,所有传输层都遵守);pi 侧沿用 pi 移植的 `before_provider_request` payload 过滤(pi 端口已验证有效)。
- **`minimalSystemPrompt`(默认 `true`)**:目标模型的系统提示被整体改写为 DSH minimal 人设(`You are a helpful software engineer assistant.`,与上游 Harness `minimal` preset 逐字节一致)。这是与工具目录**同级**的轨迹锚点:改写措辞会破坏 `We need` 推理风格,故永久生效(整段会话),只有工具目录提升。设 `false` 保留宿主默认系统提示。omp 经 `before_agent_start` 返回 `systemPrompt` 替换;pi 经 payload 的顶层 `system` / `messages[0]`(role `system`/`developer`)改写。
- **默认 bootstrap 工具对 `["bash", "edit"]`**:上游 dsh-anchored-standard 实测的 Minimal 工具 schema 是持久 `bash` + `str_replace_editor`(issue #11:该 schema 在适配器默认 maxTokens 下 5/5 锚定 `We need`,`bash`/`read` 等 standard 族 schema 11/11 失败)。omp/pi 工具目录没有 `str_replace_editor`,故默认使用宿主等价对 `bash` + `edit`(单文件精确替换编辑器,即 shell + 编辑器);若目录里存在 `str_replace_editor`(例如 DSH 方言),可显式配置 `["bash", "str_replace_editor"]`。`bash`/`pwsh` 条目会按目录里实际存在的平台 shell 归一化(`pwsh` 优先,对齐上游 router-bootstrap)。
- **`bootstrapMaxTokens`(默认不封顶,仅 pi)**:可选的首请求输出预算封顶。上游 issue #11 实测:Minimal 工具 schema 在适配器默认 maxTokens(256000)下**无需封顶**即可锚定 `We need` 轨迹(5/5),而封顶的送达依赖 profile package 的 `prepareCall` 行为(rc.5 源码可达请求,rc.6 预构建包会被 `adapterDefaults.maxTokens` 覆盖)。故默认不封顶(opt-in);配置后才封顶,提升后剥离注入的上限。omp 无原生 max-token 控制且 `before_provider_request` 返回值被 openai-completions 传输层丢弃,故此配置在 omp 侧仅做校验、不生效。
- **`taskRouting`(默认 `false`,仅 `two-tool` 模式)**:参考 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) / dsh-router-standard 的实测路由。首轮前从会话第一条用户消息分类任务:`react`(新建/开发)→ doer persona + 写优先工具(`read`/`write`/`edit`);`spec`(修复/维护)→ DSH minimal persona + 读优先工具(`read`/`edit`/`glob`/`grep`);`weak`(模糊/无关键词)→ 模型自分类 persona(w6c/w7)+ 写优先工具。**Flash 模型一律强制 `weak`**(w7 + 静态深度思考/决策闭环锚,参考 [v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go):omp/pi 无 DSH 式 per-message inbox,近场引导必须静态并入 persona)。路由工具缺失时回退到 `bootstrapTools`,再缺失才 fail-safe。默认 `false` 走纯 anchored-standard(固定 DSH minimal persona + `bootstrapTools`),实测稳定复现 `We need` 风格;设 `true` 启用任务感知路由。
- **`suppressedContextSources`(默认 `["skill-catalog", "agent-instructions"]`)**:首请求剥离自动注入的 AGENTS.md / skill-catalog / workspace 摘要——上游 issue #11 的 omp/pi 移植。消息携带 `source.kind` 时按来源精确过滤;omp/pi 消息无 `source.kind`,故按「只保留 system + last user」重建。显式配置 `[]` 关闭剥离而保留工具锚定。含 assistant/toolResult 的多轮历史不重建。

上游新增的实验对比模式:首请求**零工具** + 一条固定 anchor 用户消息(默认 `This round is a test. Tools are not open yet; all tools will open next round.`,可配置;上游 whoami-standard 的 `你是谁` 也可通过 `anchorText` 配置),让第一条推理链走零注入轨迹;anchor 回复落库后恢复完整目录。本插件的移植:

- 首请求活动工具集置空(`omp` 经 `setActiveTools([])`;pi 经 payload `tools: []`),并把最后一个 user 消息的内容替换为 anchor 文本(真实消息仍持久化在会话里,下一轮继续时用完整目录回答)。
- 提升信号固定为 `assistant-message`(anchor 回复),忽略 `promoteOn`。
- 子代理(task)会话豁免:omp 会话条目含 `session_init` → 所有模式始终完整目录(pi 无 `session_init`,同等对待)。
- **compaction 后**:zero 模式不再注入 anchor;若配置了 `compactionTools`,首轮暴露平台 shell + 该工作集,否则继续保持零工具,直到新的 assistant 消息重新提升。
- **与上游的差异**:上游把真实消息自动推迟到下一轮(带工具的轮次);本插件无法安全推迟持久化消息,故 anchor 轮结束后需要用户继续一句(anchor 回复本身会提示),真实消息在后续轮次用完整目录回答。

## 目录结构

```text
src/
  core.ts   # 共享纯逻辑:toolName / deepMerge / matchGlob / modelMatches / promotionPhase / routeTaskMode / selectBootstrapTools / selectZeroBootstrapTools / filterTools / zeroAnchorPayload / stripContextMessages / rewriteSystemPrompt / capMaxTokens / countTrajectory / extractRaw / applyDefaults / validateRawConfig
  omp.ts    # omp 入口:setActiveTools 收窄/恢复 + context 注入 anchor + before_agent_start 替换 systemPrompt + config.yml(YAML)
  pi.ts     # pi 入口:before_provider_request + buildContextEntries() + settings.json
test/
  core.test.ts   # node:test 单测(130 例)
```

## 安装

已发布到 npm(`omp-pi-anchored-standard@0.8.0`)。仓库的 `package.json` 也声明了两个宿主的入口(`omp.extensions` / `pi.extensions`),npm 与 git 安装都会自动加载正确入口。

### omp

npm(推荐):

```sh
omp plugin install omp-pi-anchored-standard
```

或从仓库安装:

```sh
omp plugin install github:Aurzex/omp-pi-anchored-standard
```

> `omp plugin install` 依赖本机 `bun` 命令;没有 bun 时,手动拷进扩展目录即可:
>
> ```sh
> mkdir -p ~/.omp/agent/extensions
> cp -r /path/to/omp-pi-anchored-standard ~/.omp/agent/extensions/omp-pi-anchored-standard
> ```

默认配置即可用(自动锚定 `deepseek-v4-pro`,纯 anchored-standard;`taskRouting` 默认关闭)。如需覆盖,在全局 `~/.omp/agent/config.yml` 或某项目的 `<项目>/.omp/config.yml` 配置:

```yaml
anchoredTools:
    enabled: true
    models:
        - deepseek-v4-pro # 默认值;glob;含 "/" 只匹配 "provider/modelId",裸名两种都匹配
    bootstrapMode: two-tool # "two-tool" | "zero"
    bootstrapTools:
        - bash
        - edit # 默认 shell+编辑器对(等价 DSH Minimal 的 bash+str_replace_editor)
    promoteOn: either # "tool-call" | "assistant-message" | "either"
    minimalSystemPrompt: true # 系统提示 → DSH/route persona(永久)
    suppressedContextSources:
        - skill-catalog
        - agent-instructions # 显式 [] 关闭首请求上下文剥离
    compactionTools: [] # compaction 后、重新提升前的工作集(默认无)
    notify: true # 提升时一次性 TUI 通知
```

项目配置深合并覆盖全局:嵌套对象递归合并、**数组整体替换**(不拼接)、项目优先。改完重启 omp。

### pi

npm(推荐):

```sh
pi install omp-pi-anchored-standard
```

或把仓库加进 `~/.pi/agent/settings.json` 的 `packages`,`/reload` 后自动安装:

```jsonc
{ "packages": ["git:github.com/Aurzex/omp-pi-anchored-standard@v0.8.0"] }
```

默认配置即可用(自动锚定 `deepseek-v4-pro`,纯 anchored-standard;`taskRouting` 默认关闭)。如需覆盖,在全局 `~/.pi/agent/settings.json` + 可信项目的 `.pi/settings.json` 配置(语义同上):

```jsonc
{
	"anchoredTools": {
		"enabled": true,
		"models": ["deepseek-v4-pro"],
		"bootstrapMode": "two-tool",
		"bootstrapTools": ["bash", "edit"],
		"promoteOn": "either",
		"minimalSystemPrompt": true,
		"taskRouting": false,
		"anchorText": "This round is a test. Tools are not open yet; all tools will open next round.",
		"suppressedContextSources": ["skill-catalog", "agent-instructions"],
		"compactionTools": [],
		"notify": true,
	},
}
```

改完 `/reload`。

> 版本锁:git 安装可用 `@v0.8.0`(pi)/ `#v0.8.0`(omp);npm 安装默认就是 `latest`(`0.8.0`)。

## 验证

会话里跑 `/anchored-tools`,报告当前模型、是否命中目标、模式、任务路由、提升触发器、当前阶段(`bootstrap` / `promoted (full catalog)` / `not-targeted` / `disabled`),以及轨迹指纹(`we` / `let's` / `let me` 计数)。

首次锚定与系统提示改写会打日志(omp 走 `pi.logger`,pi 走 console):

```
[anchored-tools] anchoring first request for deepseek/deepseek-v4-pro: 5/25 tools (read, edit, glob, grep, bash) [task-routing spec]   # two-tool
[anchored-tools] anchoring first request for deepseek/deepseek-v4-pro: 4/25 tools (read, write, edit, bash) [task-routing react]      # two-tool
[anchored-tools] anchoring first request for deepseek/deepseek-v4-flash: 0 tools (zero-tool anchor)                                  # zero
[anchored-tools] deepseek/deepseek-v4-pro: system prompt → route persona (react)                                                     # taskRouting
```

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test(原生 TS,无需 bun;bun 环境同样可跑 node:test)
```

## 已知限制

- **omp** 用 `setActiveTools` 收窄活动工具集,对**所有**传输层生效(含 in-band 方言:方言目录由活动工具生成,空/收窄集合会同步反映到 system prompt 目录块);**pi** 用 `before_provider_request` payload 过滤(pi 端口验证有效,本机未装 pi 无法复测)。
- omp 的 `before_provider_request` payload 替换对 openai-completions 传输(deepseek 等)无效(上游丢弃返回值),故 omp 入口不依赖它。
- `bootstrapMode: "zero"` 的 anchor 轮结束需用户继续一句(真实消息不自动推迟),见上文差异说明。
- pi 侧无 `session_init` 条目,子代理豁免仅 omp 生效(所有模式);pi 子代理与其他会话同等对待。
- `bootstrapMaxTokens` 默认不封顶(opt-in),且仅 pi 生效:omp 无原生 max-token setter,其 `before_provider_request` 返回值被 openai-completions 传输层丢弃(见上),故 omp 只校验该配置、不施加输出预算封顶。
- `models` 默认 `["deepseek-v4-pro"]`;显式配置 `[]` 可关闭锚定,不再要求用户必须配置目标模型。
- 上游 `suppressedContextSources` 已移植:消息带 `source.kind` 时按来源过滤;omp/pi 消息无 `source.kind`,故首请求重建为 `[system, user]`;`[]` 关闭剥离。

## 参考实现

本插件是以下上游实测 preset 的 omp/pi 移植,默认零配置覆盖官方 API 与 opencode-go 两条路径:

| 路径        | Flash                                                                                       | Pro                                                                          |
| ----------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 官方 API    | [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)(dsh-router-standard)    | [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) |
| opencode-go | [v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go) | [myDshPresets](https://github.com/0liveiraaa/myDshPresets)                   |

采纳要点:

- `bootstrapTools` 默认 `["bash", "edit"]`:dsh-anchored-standard 实测 Minimal schema 是 `bash` + `str_replace_editor`;omp/pi 无 `str_replace_editor`,用宿主单文件精确替换编辑器 `edit` 等价替代。
- `taskRouting` 下 Flash 一律 `weak` 并静态并入 w7 深度思考/决策闭环锚(v4-flash-godmode 对 opencode-go 的适配;omp/pi 同样无 DSH 式 per-message inbox,动态近场引导不可用)。
- 平台 shell 选择 `pwsh` 优先(dsh-router-standard router-bootstrap)。
- `compactionTools` / compaction epoch 移植自 dsh-anchored-standard `compaction-epoch.mjs`(compaction 后作为「第二个首请求」重新锚定)。
- zero 模式与首请求上下文剥离对应 dsh-anchored-standard 的 zero-anchored-standard / whoami-standard(`anchorText` 可配 `你是谁`)与 `suppressedContextSources`(issue #11);myDshPresets 的 warmup 轮思路与 zero 模式同源(warmupbetter 对应官方 API,warmupbetter-replay 对应 opencode-go)。

## License

MIT。概念移植自 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)(MIT,本身派生自 DeepSeek Harness Standard preset)、[`yjh051108/dsh-routing-suite`](https://github.com/yjh051108/dsh-routing-suite)(MIT)、[`SheberDavid/v4-flash-godmode-opencode-go`](https://github.com/SheberDavid/v4-flash-godmode-opencode-go)(MIT)与 [`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro)(MIT)。与 DeepSeek / pi 项目无关联,未经其背书。
