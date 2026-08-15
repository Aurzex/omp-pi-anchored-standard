# omp-pi-anchored-standard

给 **omp**(Oh My Pi)和 **pi**(pi-coding-agent)用的 "anchored standard" 插件:把目标模型的**第一个请求**锚定到最小工具目录 + 小输出预算 + DSH minimal 系统人设,会话记录到**第一个持久提升信号**后恢复完整工具目录与正常预算。

## 为什么存在

DeepSeek V4 Pro 对 API 可见的工具目录高度敏感。Project2 评测(DeepSeek V4 Pro, `reasoningEffort=max`)中:

| Preset                | Ability (run1/run2) | `let me` 计数 | 工具目录       |
| --------------------- | ------------------: | ------------: | -------------- |
| Standard              |                  91 |           208 | 完整 (25 个)   |
| PTC                   |                  92 |           194 | `run_code`     |
| Minimal               |             99 / 96 |         0 / 0 | 2 个           |
| **Anchored Standard** |         **98 / 99** |     **1 / 0** | 先 2 个,后完整 |

也就是:宽工具目录对**首请求**有害(高 `let me`、计划退化),但永久停在 Minimal 会丢掉 Standard 的工具集。两阶段做法:

1. **第一个模型请求** → 只暴露 `bash` + `read`(`bootstrapMode: "two-tool"`,默认),或零工具 + 固定 anchor 回合(`bootstrapMode: "zero"`)。
2. **第一个持久提升信号之后**(按 `promoteOn`)→ 恢复完整目录(能力无损失)。

> 这是 prompt 条件化实验补丁,不是正确性保证;底层评测是单一私人评测,不是普适结论。无网络请求、无遥测。

## 行为语义

- **`promoteOn`(默认 `either`)**:`tool-call` = 第一个持久 tool call;`assistant-message` = 第一个持久 assistant 消息;`either` = 两者先到者。默认 `either` 避免"纯文本首答把会话永远困在 bootstrap"(上游的默认选择;pi 移植的 `tool-call` 行为可通过配置恢复)。
- 失败的 tool call 也算持久信号 → 提升。
- 目录每会话**只变一次**(一次 request-prefix cache 断层)。
- 阶段从**持久会话条目**推导(`getBranch()` / `buildContextEntries()`),`/resume`、`/reload` 自动保留。
- 配置里的 bootstrap 工具名在目录里缺失 → **fail-safe**:跳过过滤并告警,绝不静默剥工具。
- 非目标模型完全不受影响;`models` 默认空数组 = 谁也不锚定(安全默认)。
- 两阶段提升决策按会话 id 在进程内记忆,扫描只做一次。
- **宿主机制不同**(行为一致):omp 侧通过 `pi.setActiveTools()` 原生收窄/恢复活动工具集(`before_provider_request` 的 payload 替换在 openai-completions 传输层被丢弃,不可靠),zero 模式 anchor 消息经 `context` 事件注入(序列化前生效,所有传输层都遵守);pi 侧沿用 pi 移植的 `before_provider_request` payload 过滤(pi 端口已验证有效)。
- **`minimalSystemPrompt`(默认 `true`)**:目标模型的系统提示被整体改写为 DSH minimal 人设(`You are a helpful software engineer assistant.`,与上游 Harness `minimal` preset 逐字节一致)。这是与工具目录**同级**的轨迹锚点:改写措辞会破坏 `We need` 推理风格,故永久生效(整段会话),只有工具目录提升。设 `false` 保留宿主默认系统提示。omp 经 `before_agent_start` 返回 `systemPrompt` 替换;pi 经 payload 的顶层 `system` / `messages[0]`(role `system`/`developer`)改写。
- **`bootstrapMaxTokens`(默认 `1024`,仅 pi)**:首请求输出预算封顶(上游 issue #6:首请求 `max_tokens` 主导轨迹锚点——1024 复现 `We need` 风格 26/32 次,而适配器默认 256000 是 0/5)。提升后剥离注入的上限,恢复宿主默认。omp 无原生 max-token 控制且 `before_provider_request` 返回值被 openai-completions 传输层丢弃,故此配置在 omp 侧仅做校验、不生效。

上游新增的实验对比模式:首请求**零工具** + 一条固定 anchor 用户消息(默认 `This round is a test. Tools are not open yet; all tools will open next round.`,可配置),让第一条推理链走零注入轨迹;anchor 回复落库后恢复完整目录。本插件的移植:

- 首请求活动工具集置空(`omp` 经 `setActiveTools([])`;pi 经 payload `tools: []`),并把最后一个 user 消息的内容替换为 anchor 文本(真实消息仍持久化在会话里,下一轮继续时用完整目录回答)。
- 提升信号固定为 `assistant-message`(anchor 回复),忽略 `promoteOn`。
- 子代理(task)会话豁免:omp 会话条目含 `session_init` → 始终完整目录。
- **与上游的差异**:上游把真实消息自动推迟到下一轮(带工具的轮次);本插件无法安全推迟持久化消息,故 anchor 轮结束后需要用户继续一句(anchor 回复本身会提示),真实消息在后续轮次用完整目录回答。pi 侧无 `session_init` 条目,子代理豁免是 omp 专属(pi 子代理与其他会话同等对待)。

## 目录结构

```text
src/
  core.ts   # 共享纯逻辑:toolName / deepMerge / matchGlob / modelMatches / hasToolCallHistory / hasAssistantMessage / isSubagentSession / isPromoted / filterTools / zeroAnchorPayload / rewriteSystemPrompt / capMaxTokens / extractRaw / applyDefaults
  omp.ts    # omp 入口:setActiveTools 收窄/恢复 + context 注入 anchor + before_agent_start 替换 systemPrompt + config.yml(YAML)
  pi.ts     # pi 入口:before_provider_request + buildContextEntries() + settings.json
test/
  core.test.ts   # node:test 单测(78 例)
```

## 安装

已发布到 npm(`omp-pi-anchored-standard@0.3.0`)。仓库的 `package.json` 也声明了两个宿主的入口(`omp.extensions` / `pi.extensions`),npm 与 git 安装都会自动加载正确入口。

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

然后配置(全局 `~/.omp/agent/config.yml`,或某项目的 `<项目>/.omp/config.yml`):

```yaml
anchoredTools:
    enabled: true
    models:
        - deepseek-v4-flash # glob;含 "/" 只匹配 "provider/modelId",裸名两种都匹配
    bootstrapMode: two-tool # "two-tool" | "zero"
    bootstrapTools:
        - bash
        - read # two-tool 模式专用
    promoteOn: either # "tool-call" | "assistant-message" | "either"
    minimalSystemPrompt: true # 系统提示 → DSH minimal 人设(永久)
    bootstrapMaxTokens: 1024 # 首请求输出预算上限(仅 pi 生效)
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
{ "packages": ["git:github.com/Aurzex/omp-pi-anchored-standard@v0.3.0"] }
```

然后配置(全局 `~/.pi/agent/settings.json` + 可信项目的 `.pi/settings.json` 覆盖,语义同上):

```jsonc
{
	"anchoredTools": {
		"enabled": true,
		"models": ["deepseek-v4-pro"],
		"bootstrapMode": "two-tool",
		"bootstrapTools": ["bash", "read"],
		"promoteOn": "either",
		"minimalSystemPrompt": true,
		"bootstrapMaxTokens": 1024,
		"anchorText": "This round is a test. Tools are not open yet; all tools will open next round.",
		"notify": true,
	},
}
```

改完 `/reload`。

> 版本锁:git 安装可用 `@v0.3.0`(pi)/ `#v0.3.0`(omp);npm 安装默认就是 `latest`(`0.3.0`)。

## 验证

会话里跑 `/anchored-tools`,报告当前模型、是否命中目标、模式、提升触发器、当前阶段(`bootstrap` / `promoted (full catalog)` / `not-targeted` / `disabled`)。

首次锚定与系统提示改写会打日志(omp 走 `pi.logger`,pi 走 console):

```
[anchored-tools] anchoring first request for deepseek/deepseek-v4-flash: 2/25 tools (bash, read)   # two-tool
[anchored-tools] anchoring first request for deepseek/deepseek-v4-flash: 0 tools (zero-tool anchor) # zero
[anchored-tools] deepseek/deepseek-v4-flash: system prompt → DSH minimal persona                     # minimalSystemPrompt
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
- pi 侧无 `session_init` 条目,zero 模式的子代理豁免仅 omp 生效。
- `bootstrapMaxTokens` 仅 pi 生效:omp 无原生 max-token setter,且其 `before_provider_request` 返回值被 openai-completions 传输层丢弃(见上),故 omp 只校验该配置、不施加输出预算封顶。
- `models` 必须在配置里显式列出目标模型;默认空数组不锚定任何模型。

## License

MIT。概念移植自 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)(MIT,本身派生自 DeepSeek Harness Standard preset)与 [`dbydd/pi-anchored-tool-for-dspro`](https://github.com/dbydd/pi-anchored-tool-for-dspro)(MIT)。与 DeepSeek / pi 项目无关联,未经其背书。
