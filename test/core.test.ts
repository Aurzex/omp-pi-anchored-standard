import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	ANCHOR_TEXT,
	addTrajectory,
	anchorContent,
	anchorPayloadMessages,
	applyDefaults,
	capMaxTokens,
	classifyTask,
	countTrajectory,
	deepMerge,
	extractRaw,
	filterTools,
	hasAssistantMessage,
	hasToolCallHistory,
	isFlashModel,
	isPositiveInt,
	isPromoted,
	isSubagentSession,
	isTargetModel,
	lastUserIndex,
	matchGlob,
	memoizedIsPromoted,
	MINIMAL_SYSTEM_PROMPT,
	modelMatches,
	normalizeShellTools,
	platformShell,
	promoteTrigger,
	promotionPhase,
	resolveBootstrap,
	rewriteSystemPrompt,
	routerPersonaFor,
	routerBootstrapTools,
	routeTaskMode,
	selectBootstrapTools,
	selectPromotedTools,
	selectZeroBootstrapTools,
	SessionPromotionMemo,
	shouldRestoreFullCatalog,
	stripContextMessages,
	taskTextFromEntries,
	taskTextFromMessages,
	toolName,
	trajectoryTextFromMessage,
	validateRawConfig,
	zeroAnchorPayload,
	type RawConfig,
} from "../src/core.ts";

describe("toolName", () => {
	test("openai function shape", () => {
		assert.equal(
			toolName({ type: "function", function: { name: "bash" } }),
			"bash",
		);
	});
	test("openai custom/grammar shape", () => {
		assert.equal(
			toolName({ type: "custom", custom: { name: "read" } }),
			"read",
		);
	});
	test("anthropic shape", () => {
		assert.equal(toolName({ name: "edit" }), "edit");
	});
	test("unknown shape returns undefined", () => {
		assert.equal(toolName({}), undefined);
	});
});

describe("matchGlob", () => {
	test("exact", () => {
		assert.equal(matchGlob("deepseek-v4-pro", "deepseek-v4-pro"), true);
		assert.equal(matchGlob("deepseek-v4-pro", "deepseek-v4-flash"), false);
	});
	test("star wildcard", () => {
		assert.equal(matchGlob("*", "anything"), true);
		assert.equal(matchGlob("deepseek/*", "deepseek/deepseek-v4-pro"), true);
		assert.equal(matchGlob("deepseek/*", "openai/gpt-5.6"), false);
		assert.equal(
			matchGlob("*/deepseek-v4-pro", "deepseek/deepseek-v4-pro"),
			true,
		);
	});
	test("case-insensitive", () => {
		assert.equal(matchGlob("DEEPSEEK-V4-PRO", "deepseek-v4-pro"), true);
	});
});

describe("modelMatches", () => {
	test("bare pattern matches qualified or bare id", () => {
		assert.equal(
			modelMatches("deepseek-v4-pro", "deepseek", ["deepseek-v4-pro"]),
			true,
		);
		assert.equal(
			modelMatches("deepseek-v4-pro", "openrouter", ["deepseek-v4-pro"]),
			true,
		);
	});
	test("qualified pattern requires provider", () => {
		assert.equal(
			modelMatches("deepseek-v4-pro", "deepseek", [
				"deepseek/deepseek-v4-pro",
			]),
			true,
		);
		assert.equal(
			modelMatches("deepseek-v4-pro", "openrouter", [
				"deepseek/deepseek-v4-pro",
			]),
			false,
		);
	});
	test("empty patterns never match", () => {
		assert.equal(modelMatches("deepseek-v4-pro", "deepseek", []), false);
	});
});

describe("hasToolCallHistory", () => {
	test("empty history", () => {
		assert.equal(
			hasToolCallHistory([
				{ type: "message", message: { role: "user" } },
			]),
			false,
		);
	});
	test("toolResult promotes", () => {
		assert.equal(
			hasToolCallHistory([
				{
					type: "message",
					message: { role: "toolResult", toolName: "bash" },
				},
			]),
			true,
		);
	});
	test("assistant toolCall promotes", () => {
		assert.equal(
			hasToolCallHistory([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall" }],
					},
				},
			]),
			true,
		);
	});
	test("assistant text without toolCall does not promote", () => {
		assert.equal(
			hasToolCallHistory([
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text" }] },
				},
			]),
			false,
		);
	});
	test("non-message session entries are ignored (omp shapes)", () => {
		const entries = [
			{ type: "session_init", systemPrompt: "...", tools: ["read"] },
			{ type: "custom", customType: "com.example.state", data: { x: 1 } },
			{ type: "branch_summary", fromId: "root", summary: "..." },
		];
		assert.equal(hasToolCallHistory(entries), false);
	});
	test("toolCall anywhere in the branch promotes (omp shapes)", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hi" }],
				},
			},
			{ type: "label", targetId: "x", label: "checkpoint" },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "bash" }],
				},
			},
		];
		assert.equal(hasToolCallHistory(entries), true);
	});
});

describe("hasAssistantMessage", () => {
	test("assistant text promotes", () => {
		assert.equal(
			hasAssistantMessage([
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text" }] },
				},
			]),
			true,
		);
	});
	test("assistant toolCall message counts as an assistant message", () => {
		assert.equal(
			hasAssistantMessage([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall" }],
					},
				},
			]),
			true,
		);
	});
	test("user and toolResult messages do not", () => {
		assert.equal(
			hasAssistantMessage([
				{ type: "message", message: { role: "user" } },
			]),
			false,
		);
		assert.equal(
			hasAssistantMessage([
				{ type: "message", message: { role: "toolResult" } },
			]),
			false,
		);
	});
	test("empty history does not", () => {
		assert.equal(hasAssistantMessage([]), false);
	});
});

describe("isSubagentSession", () => {
	test("session_init entry marks a subagent session (omp)", () => {
		assert.equal(isSubagentSession([{ type: "session_init" }]), true);
	});
	test("plain message history is not a subagent session", () => {
		assert.equal(
			isSubagentSession([{ type: "message", message: { role: "user" } }]),
			false,
		);
	});
});

describe("isPromoted", () => {
	const textAssistant = [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text" }] },
		},
	];
	const toolCall = [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall" }] },
		},
	];

	test("tool-call trigger ignores text-only assistant messages", () => {
		assert.equal(isPromoted(textAssistant, "tool-call"), false);
		assert.equal(isPromoted(toolCall, "tool-call"), true);
	});
	test("assistant-message trigger promotes on any assistant message", () => {
		assert.equal(isPromoted(textAssistant, "assistant-message"), true);
		assert.equal(isPromoted(toolCall, "assistant-message"), true);
	});
	test("either trigger fires on whichever comes first", () => {
		assert.equal(isPromoted(textAssistant, "either"), true);
		assert.equal(isPromoted(toolCall, "either"), true);
		assert.equal(
			isPromoted(
				[{ type: "message", message: { role: "user" } }],
				"either",
			),
			false,
		);
	});
});

test("promotionPhase is epoch-aware across compactions", () => {
	const assistant = {
		type: "message",
		message: { role: "assistant", content: [{ type: "text" }] },
	};
	const compaction = { type: "compaction" };
	assert.deepStrictEqual(
		promotionPhase([assistant, compaction], "assistant-message"),
		{ boundary: 1, promoted: false },
	);
	assert.deepStrictEqual(
		promotionPhase([assistant, compaction, assistant], "assistant-message"),
		{ boundary: 1, promoted: true },
	);
	assert.deepStrictEqual(promotionPhase([], "either"), {
		boundary: -1,
		promoted: false,
	});
});

describe("SessionPromotionMemo / memoizedIsPromoted", () => {
	test("memo hit returns true without rescanning entries", () => {
		const memo = new SessionPromotionMemo();
		let scans = 0;
		const promotedEntries = () => {
			scans++;
			return [
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text" }] },
				},
			];
		};
		assert.equal(
			memoizedIsPromoted(memo, "s", "either", promotedEntries),
			true,
		);
		assert.equal(scans, 1);
		assert.equal(
			memoizedIsPromoted(memo, "s", "either", () => {
				scans++;
				return [];
			}),
			true,
		);
		assert.equal(scans, 1); // second call skipped the scan
	});

	test("unpromoted scan records promotion once it flips", () => {
		const memo = new SessionPromotionMemo();
		assert.equal(
			memoizedIsPromoted(memo, "s", "tool-call", () => []),
			false,
		);
		assert.equal(memo.has("s"), false);
		assert.equal(
			memoizedIsPromoted(memo, "s", "tool-call", () => [
				{ type: "message", message: { role: "toolResult" } },
			]),
			true,
		);
		assert.equal(memo.has("s"), true);
	});

	test("clear forgets promoted sessions", () => {
		const memo = new SessionPromotionMemo();
		memo.add("s");
		memo.clear();
		assert.equal(memo.has("s"), false);
	});

	test("delete forgets one session (compaction reset)", () => {
		const memo = new SessionPromotionMemo();
		memo.add("s1");
		memo.add("s2");
		memo.delete("s1");
		assert.equal(memo.has("s1"), false);
		assert.equal(memo.has("s2"), true);
	});

	test("missing sid disables the memo", () => {
		const memo = new SessionPromotionMemo();
		let scans = 0;
		const promotedEntries = () => {
			scans++;
			return [
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text" }] },
				},
			];
		};
		assert.equal(
			memoizedIsPromoted(memo, undefined, "either", promotedEntries),
			true,
		);
		assert.equal(
			memoizedIsPromoted(memo, undefined, "either", promotedEntries),
			true,
		);
		assert.equal(scans, 2);
	});
});

describe("shouldRestoreFullCatalog", () => {
	const cfg = applyDefaults({ models: ["deepseek-v4-pro"] });

	test("disabled config restores", () => {
		assert.equal(
			shouldRestoreFullCatalog(
				{ ...cfg, enabled: false },
				{ id: "deepseek-v4-pro", provider: "deepseek" },
			),
			true,
		);
	});

	test("empty target list restores", () => {
		assert.equal(
			shouldRestoreFullCatalog(
				{ ...cfg, models: [] },
				{ id: "deepseek-v4-pro", provider: "deepseek" },
			),
			true,
		);
	});

	test("unknown model keeps the narrowed catalog", () => {
		assert.equal(shouldRestoreFullCatalog(cfg, undefined), false);
	});

	test("known non-target model restores", () => {
		assert.equal(
			shouldRestoreFullCatalog(cfg, { id: "gpt-5", provider: "openai" }),
			true,
		);
	});

	test("known target model does not force a restore", () => {
		assert.equal(
			shouldRestoreFullCatalog(cfg, {
				id: "deepseek-v4-pro",
				provider: "deepseek",
			}),
			false,
		);
	});
});

describe("shared config helpers", () => {
	const cfg = applyDefaults({ models: ["deepseek-v4-pro"] });

	test("isTargetModel matches enabled target models", () => {
		assert.equal(
			isTargetModel(cfg, {
				id: "deepseek-v4-pro",
				provider: "deepseek",
			}),
			true,
		);
		assert.equal(
			isTargetModel(cfg, { id: "gpt-5", provider: "openai" }),
			false,
		);
		assert.equal(isTargetModel(cfg, undefined), false);
	});

	test("isTargetModel respects the enabled flag", () => {
		assert.equal(
			isTargetModel(
				{ ...cfg, enabled: false },
				{ id: "deepseek-v4-pro", provider: "deepseek" },
			),
			false,
		);
	});

	test("promoteTrigger maps zero mode to the assistant-message trigger", () => {
		assert.equal(promoteTrigger(cfg), "either");
		assert.equal(
			promoteTrigger({ ...cfg, bootstrapMode: "zero" }),
			"assistant-message",
		);
		assert.equal(
			promoteTrigger({
				...cfg,
				bootstrapMode: "two-tool",
				promoteOn: "either",
			}),
			"either",
		);
	});

	test("validateRawConfig warns about invalid values", () => {
		const warnings: string[] = [];
		validateRawConfig(
			{
				bootstrapMode: "one-tool",
				promoteOn: "tool_call",
				bootstrapMaxTokens: 0,
			},
			(message) => warnings.push(message),
			"anchored-tools",
		);
		assert.equal(warnings.length, 3);
		assert.ok(warnings[0]!.includes("invalid bootstrapMode"));
		assert.ok(warnings[1]!.includes("invalid promoteOn"));
		assert.ok(warnings[2]!.includes("invalid bootstrapMaxTokens"));
	});

	test("validateRawConfig is silent for valid values", () => {
		const warnings: string[] = [];
		validateRawConfig(
			{
				bootstrapMode: "two-tool",
				promoteOn: "either",
				bootstrapMaxTokens: 1024,
			},
			(message) => warnings.push(message),
			"anchored-tools",
		);
		assert.equal(warnings.length, 0);
	});

	test("validateRawConfig warns about unknown keys", () => {
		const warnings: string[] = [];
		validateRawConfig(
			{ suppressContext: true } as unknown as RawConfig,
			(message) => warnings.push(message),
			"anchored-tools",
		);
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0]!.includes("unknown anchoredTools key(s)"));
	});
});

describe("resolveBootstrap", () => {
	test("returns the bootstrap set when all tools are present", () => {
		assert.deepStrictEqual(
			resolveBootstrap(["bash", "read", "edit"], ["bash", "read"]),
			{
				tools: ["bash", "read"],
				missing: [],
			},
		);
	});
	test("deduplicates the bootstrap set", () => {
		assert.deepStrictEqual(
			resolveBootstrap(["bash", "read"], ["bash", "bash"]),
			{
				tools: ["bash"],
				missing: [],
			},
		);
	});
	test("missing bootstrap tool fails safe with empty tools", () => {
		assert.deepStrictEqual(
			resolveBootstrap(["bash", "read"], ["bash", "pwsh"]),
			{
				tools: [],
				missing: ["pwsh"],
			},
		);
	});
});

describe("deepMerge (settings semantics)", () => {
	test("nested objects merge recursively", () => {
		assert.deepStrictEqual(
			deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } }),
			{
				a: { x: 1, y: 3, z: 4 },
			},
		);
	});
	test("arrays are replaced wholesale, never concatenated", () => {
		assert.deepStrictEqual(
			deepMerge({ models: ["a", "b"] }, { models: ["c"] }),
			{
				models: ["c"],
			},
		);
	});
	test("undefined overrides are skipped", () => {
		assert.deepStrictEqual(
			deepMerge({ a: 1, b: 2 }, { b: undefined, c: 3 }),
			{ a: 1, b: 2, c: 3 },
		);
	});
	test("scalar overrides replace", () => {
		assert.deepStrictEqual(
			deepMerge({ enabled: true, notify: true }, { enabled: false }),
			{
				enabled: false,
				notify: true,
			},
		);
	});
	test("undefined base returns overrides clone", () => {
		assert.deepStrictEqual(deepMerge(undefined, { models: ["x"] }), {
			models: ["x"],
		});
	});
	test("non-object overrides replace wholesale", () => {
		assert.equal(deepMerge({ a: { deep: 1 } }, "boom"), "boom");
	});
});

describe("filterTools", () => {
	const catalog: any[] = [
		{ type: "function", function: { name: "bash" } },
		{ type: "function", function: { name: "read" } },
		{ type: "function", function: { name: "edit" } },
		{ name: "write" },
	];

	test("narrows to bootstrap set", () => {
		const r = filterTools(catalog, ["bash", "read"]);
		assert.equal(r.changed, true);
		assert.deepStrictEqual(r.tools.map(toolName), ["bash", "read"]);
		assert.deepStrictEqual(r.missing, []);
	});

	test("missing bootstrap tool fails safe", () => {
		const r = filterTools(catalog, ["bash", "pwsh"]);
		assert.equal(r.changed, false);
		assert.equal(r.tools, catalog);
		assert.deepStrictEqual(r.missing, ["pwsh"]);
	});

	test("already minimal catalog is unchanged", () => {
		const r = filterTools(catalog.slice(0, 2), ["bash", "read"]);
		assert.equal(r.changed, false);
	});

	test("empty catalog is unchanged", () => {
		const r = filterTools([], ["bash", "read"]);
		assert.equal(r.changed, false);
		assert.deepStrictEqual(r.missing, []);
	});

	test("undefined catalog is unchanged", () => {
		const r = filterTools(undefined, ["bash", "read"]);
		assert.equal(r.changed, false);
	});
});

describe("extractRaw", () => {
	test("undefined root yields empty raw config", () => {
		assert.deepStrictEqual(extractRaw(undefined), {});
	});
	test("root without anchoredTools yields empty raw config", () => {
		assert.deepStrictEqual(extractRaw({ theme: { dark: "x" } }), {});
	});
	test("non-object anchoredTools yields empty raw config", () => {
		assert.deepStrictEqual(extractRaw({ anchoredTools: "yes" }), {});
		assert.deepStrictEqual(extractRaw({ anchoredTools: ["bash"] }), {});
	});
	test("object anchoredTools is returned", () => {
		assert.deepStrictEqual(
			extractRaw({ anchoredTools: { models: ["x"] } }),
			{ models: ["x"] },
		);
	});
});

describe("applyDefaults", () => {
	const fullDefaults = {
		enabled: true,
		models: ["deepseek-v4-pro"],
		bootstrapTools: ["bash", "read"],
		notify: true,
		bootstrapMode: "two-tool",
		promoteOn: "either",
		anchorText: ANCHOR_TEXT,
		minimalSystemPrompt: true,
		bootstrapMaxTokens: undefined,
		taskRouting: false,
		suppressedContextSources: ["skill-catalog", "agent-instructions"],
		compactionTools: [],
		includeSubagents: false,
		promotedTools: [],
	};

	test("empty raw config resolves to DEFAULTS", () => {
		assert.deepStrictEqual(applyDefaults({}), fullDefaults);
	});
	test("model arrays are deduplicated", () => {
		assert.deepStrictEqual(
			applyDefaults({ models: ["a", "a", "b"] }).models,
			["a", "b"],
		);
	});
	test("empty bootstrapTools falls back to the default list", () => {
		assert.deepStrictEqual(
			applyDefaults({ bootstrapTools: [] }).bootstrapTools,
			["bash", "read"],
		);
	});
	test("scalars default when missing", () => {
		assert.equal(applyDefaults({ models: ["x"] }).enabled, true);
		assert.equal(applyDefaults({ models: ["x"] }).notify, true);
	});
	test("explicit scalars and lists win", () => {
		const cfg = applyDefaults({
			enabled: false,
			models: ["a"],
			bootstrapTools: ["bash"],
			notify: false,
			bootstrapMode: "zero",
			promoteOn: "tool-call",
			anchorText: "custom",
			minimalSystemPrompt: false,
			bootstrapMaxTokens: 4096,
			taskRouting: false,
		});
		assert.deepStrictEqual(cfg, {
			enabled: false,
			models: ["a"],
			bootstrapTools: ["bash"],
			notify: false,
			bootstrapMode: "zero",
			promoteOn: "tool-call",
			anchorText: "custom",
			minimalSystemPrompt: false,
			bootstrapMaxTokens: 4096,
			taskRouting: false,
			suppressedContextSources: ["skill-catalog", "agent-instructions"],
			compactionTools: [],
			includeSubagents: false,
			promotedTools: [],
		});
	});
	test("invalid bootstrapMode and promoteOn normalize to defaults", () => {
		const cfg = applyDefaults({
			bootstrapMode: "one-tool",
			promoteOn: "tool_call",
		});
		assert.equal(cfg.bootstrapMode, "two-tool");
		assert.equal(cfg.promoteOn, "either");
	});
	test("invalid bootstrapMaxTokens leaves the cap off", () => {
		assert.equal(
			applyDefaults({ bootstrapMaxTokens: 0 }).bootstrapMaxTokens,
			undefined,
		);
		assert.equal(
			applyDefaults({ bootstrapMaxTokens: -1 }).bootstrapMaxTokens,
			undefined,
		);
		assert.equal(
			applyDefaults({ bootstrapMaxTokens: 1.5 }).bootstrapMaxTokens,
			undefined,
		);
		assert.equal(
			applyDefaults({ bootstrapMaxTokens: "1024" as unknown as number })
				.bootstrapMaxTokens,
			undefined,
		);
	});
	test("empty anchorText falls back to the default anchor", () => {
		assert.equal(applyDefaults({ anchorText: "" }).anchorText, ANCHOR_TEXT);
	});

	test("empty suppressedContextSources disables the context filter", () => {
		assert.deepStrictEqual(
			applyDefaults({ suppressedContextSources: [] })
				.suppressedContextSources,
			[],
		);
	});

	test("suppressedContextSources filters invalid entries", () => {
		assert.deepStrictEqual(
			applyDefaults({
				suppressedContextSources: ["skill-catalog", "", "other"],
			}).suppressedContextSources,
			["skill-catalog", "other"],
		);
	});

	test("compactionTools defaults to empty and deduplicates", () => {
		assert.deepStrictEqual(applyDefaults({}).compactionTools, []);
		assert.deepStrictEqual(
			applyDefaults({ compactionTools: ["read", "read", "edit"] })
				.compactionTools,
			["read", "edit"],
		);
	});

	test("includeSubagents defaults false and accepts true", () => {
		assert.equal(applyDefaults({}).includeSubagents, false);
		assert.equal(
			applyDefaults({ includeSubagents: true }).includeSubagents,
			true,
		);
	});

	test("promotedTools defaults empty and deduplicates", () => {
		assert.deepStrictEqual(applyDefaults({}).promotedTools, []);
		assert.deepStrictEqual(
			applyDefaults({
				promotedTools: ["bash", "read", "read", "edit"],
			}).promotedTools,
			["bash", "read", "edit"],
		);
	});
});

describe("task routing helpers", () => {
	test("classifyTask: build/greenfield tasks are react", () => {
		assert.equal(
			classifyTask("需要本地开发一个马里奥网页小游戏，参考经典原版"),
			"react",
		);
		assert.equal(classifyTask("帮我写一个 Python 脚本处理 CSV"), "react");
		assert.equal(classifyTask("从零搭建一个网站"), "react");
	});

	test("classifyTask: fix/maintenance tasks are spec", () => {
		assert.equal(classifyTask("修复这个仓库里的 bug"), "spec");
		assert.equal(classifyTask("为什么登录一直报错，帮我排查"), "spec");
	});

	test("classifyTask: ambiguous or unmatched text is weak", () => {
		assert.equal(classifyTask("今天天气怎么样"), "weak");
		assert.equal(classifyTask("开发并修复"), "weak");
	});

	test("classifyTask: net react keywords beat spec keywords", () => {
		assert.equal(
			classifyTask("帮我开发一个小游戏然后修复里面的 bug"),
			"react",
		);
	});

	test("isFlashModel detects flash-family ids", () => {
		assert.equal(isFlashModel("deepseek-v4-flash"), true);
		assert.equal(isFlashModel("deepseek-v4-pro"), false);
	});

	test("routerPersonaFor: spec uses the byte-identical minimal persona", () => {
		assert.equal(
			routerPersonaFor("spec", "deepseek-v4-pro"),
			MINIMAL_SYSTEM_PROMPT,
		);
	});

	test("routerPersonaFor: react is the hands-on doer persona", () => {
		assert.ok(
			routerPersonaFor("react", "deepseek-v4-pro").includes("hands-on"),
		);
		assert.ok(
			routerPersonaFor("react", "deepseek-v4-pro").includes(
				"do not build test harnesses",
			),
		);
	});

	test("routerPersonaFor: weak persona is model-specific", () => {
		const pro = routerPersonaFor("weak", "deepseek-v4-pro");
		const flash = routerPersonaFor("weak", "deepseek-v4-flash");
		assert.ok(pro.includes("decide the task type (build or fix)"));
		assert.ok(pro.includes(MINIMAL_SYSTEM_PROMPT));
		assert.ok(!pro.includes("review what you have already done"));
		assert.ok(flash.includes("review what you have already done"));
		assert.ok(flash.includes("Think deeply"));
		assert.notEqual(pro, flash);
	});

	test("routerBootstrapTools: spec is read-first, react/weak write-first", () => {
		assert.deepStrictEqual(routerBootstrapTools("spec"), [
			"read",
			"edit",
			"glob",
			"grep",
		]);
		assert.deepStrictEqual(routerBootstrapTools("react"), [
			"read",
			"write",
			"edit",
		]);
		assert.deepStrictEqual(routerBootstrapTools("weak"), [
			"read",
			"write",
			"edit",
		]);
	});

	test("selectBootstrapTools: task routing adds the platform shell", () => {
		const selected = selectBootstrapTools(
			{ bootstrapTools: ["bash", "read"], taskRouting: true },
			"spec",
			["bash", "read", "edit", "glob", "grep", "write"],
		);
		assert.equal(selected.used, "router");
		assert.deepStrictEqual(selected.tools, [
			"read",
			"edit",
			"glob",
			"grep",
			"bash",
		]);
		assert.deepStrictEqual(selected.missing, []);
	});

	test("selectBootstrapTools: falls back to configured tools when router tools are missing", () => {
		const selected = selectBootstrapTools(
			{ bootstrapTools: ["bash", "read"], taskRouting: true },
			"spec",
			["bash", "read"],
		);
		assert.equal(selected.used, "configured");
		assert.deepStrictEqual(selected.tools, ["bash", "read"]);
		assert.deepStrictEqual(selected.missing, []);
	});

	test("selectBootstrapTools: disabled routing uses configured tools", () => {
		const selected = selectBootstrapTools(
			{ bootstrapTools: ["bash"], taskRouting: false },
			"react",
			["bash", "read", "write", "edit"],
		);
		assert.equal(selected.used, "configured");
		assert.deepStrictEqual(selected.tools, ["bash"]);
	});

	test("selectBootstrapTools: reports missing non-shell configured tools when routing falls back and fails", () => {
		const selected = selectBootstrapTools(
			{
				bootstrapTools: ["bash", "str_replace_editor"],
				taskRouting: true,
			},
			"spec",
			["bash", "read"],
		);
		assert.equal(selected.used, "configured");
		assert.deepStrictEqual(selected.missing, ["str_replace_editor"]);
	});

	test("selectBootstrapTools: configured shell entries normalize to the platform shell", () => {
		const selected = selectBootstrapTools(
			{ bootstrapTools: ["bash", "edit"], taskRouting: false },
			"weak",
			["pwsh", "edit", "read"],
		);
		assert.equal(selected.used, "configured");
		assert.deepStrictEqual(selected.tools, ["pwsh", "edit"]);
		assert.deepStrictEqual(selected.missing, []);
	});

	test("selectBootstrapTools: appends compactionTools after a compaction", () => {
		const selected = selectBootstrapTools(
			{
				bootstrapTools: ["bash", "edit"],
				taskRouting: false,
				compactionTools: ["read"],
			},
			"weak",
			["bash", "edit", "read", "write"],
			1,
		);
		assert.equal(selected.used, "configured");
		assert.deepStrictEqual(selected.tools, ["bash", "edit", "read"]);
		assert.deepStrictEqual(selected.missing, []);
	});

	test("selectBootstrapTools: reports missing compactionTools", () => {
		const selected = selectBootstrapTools(
			{
				bootstrapTools: ["bash", "edit"],
				taskRouting: false,
				compactionTools: ["glob"],
			},
			"weak",
			["bash", "edit"],
			1,
		);
		assert.deepStrictEqual(selected.missing, ["glob"]);
	});

	test("selectZeroBootstrapTools: first request is zero, post-compaction exposes work set", () => {
		assert.deepStrictEqual(
			selectZeroBootstrapTools(["bash", "edit"], ["read"], -1),
			{ tools: [], missing: [] },
		);
		assert.deepStrictEqual(
			selectZeroBootstrapTools(["bash", "edit"], [], 1),
			{ tools: [], missing: [] },
		);
		assert.deepStrictEqual(
			selectZeroBootstrapTools(["bash", "edit", "read"], ["read"], 1),
			{ tools: ["bash", "read"], missing: [] },
		);
		assert.deepStrictEqual(
			selectZeroBootstrapTools(["bash", "edit"], ["glob"], 1),
			{ tools: [], missing: ["glob"] },
		);
	});

	test("selectPromotedTools: empty keeps full catalog, non-empty resolves resident set", () => {
		assert.deepStrictEqual(
			selectPromotedTools(["bash", "read", "edit"], []),
			{ tools: [], missing: [] },
		);
		assert.deepStrictEqual(
			selectPromotedTools(["bash", "read", "edit"], ["bash", "read"]),
			{ tools: ["bash", "read"], missing: [] },
		);
		assert.deepStrictEqual(
			selectPromotedTools(["pwsh", "read", "edit"], ["bash", "read"]),
			{ tools: ["pwsh", "read"], missing: [] },
		);
		assert.deepStrictEqual(
			selectPromotedTools(["bash", "read"], ["bash", "glob"]),
			{ tools: [], missing: ["glob"] },
		);
	});

	test("routeTaskMode: Flash always routes weak, others use keywords", () => {
		assert.equal(
			routeTaskMode("开发一个游戏", "deepseek-v4-flash"),
			"weak",
		);
		assert.equal(
			routeTaskMode("修复这个 bug", "deepseek-v4-flash"),
			"weak",
		);
		assert.equal(routeTaskMode("开发一个游戏", "deepseek-v4-pro"), "react");
		assert.equal(routeTaskMode("修复这个 bug", "deepseek-v4-pro"), "spec");
	});

	test("platformShell / normalizeShellTools prefer pwsh over bash", () => {
		assert.equal(platformShell(["bash", "pwsh"]), "pwsh");
		assert.equal(platformShell(["bash"]), "bash");
		assert.equal(platformShell(["read"]), undefined);
		assert.deepStrictEqual(
			normalizeShellTools(["bash", "edit"], ["pwsh", "edit"]),
			["pwsh", "edit"],
		);
		assert.deepStrictEqual(
			normalizeShellTools(["bash", "pwsh", "edit"], ["pwsh", "edit"]),
			["pwsh", "edit"],
		);
	});

	test("taskTextFromEntries extracts the first user message text", () => {
		assert.equal(
			taskTextFromEntries([
				{ message: { role: "user", content: "修复这个 bug" } },
				{ message: { role: "user", content: "开发一个游戏" } },
			]),
			"修复这个 bug",
		);
		assert.equal(
			taskTextFromEntries([
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "写一个脚本" }],
					},
				},
			]),
			"写一个脚本",
		);
		assert.equal(taskTextFromEntries([]), "");
	});

	test("taskTextFromMessages extracts the first user message text", () => {
		assert.equal(
			taskTextFromMessages([
				{ role: "system", content: "s" },
				{ role: "user", content: "修复这个 bug" },
				{ role: "user", content: "开发一个游戏" },
			]),
			"修复这个 bug",
		);
		assert.equal(taskTextFromMessages([]), "");
	});
});

describe("anchor message helpers", () => {
	test("lastUserIndex finds the last user message", () => {
		const messages = [
			{ role: "system", content: "s" },
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: "c" },
		];
		assert.equal(lastUserIndex(messages), 3);
	});
	test("lastUserIndex returns -1 without a user message", () => {
		assert.equal(lastUserIndex([{ role: "system", content: "s" }]), -1);
	});
	test("anchorContent mirrors string content", () => {
		assert.equal(anchorContent("anchor", "hello"), "anchor");
	});
	test("anchorContent mirrors block content", () => {
		assert.deepStrictEqual(
			anchorContent("anchor", [{ type: "text", text: "hello" }]),
			[{ type: "text", text: "anchor" }],
		);
	});
	test("anchorContent falls back to a string", () => {
		assert.equal(anchorContent("anchor", 42), "anchor");
	});
	test("anchorPayloadMessages replaces the last user message content", () => {
		const messages = [{ role: "user", content: "real question" }];
		const next = anchorPayloadMessages(messages, "anchor");
		assert.deepStrictEqual(next, [{ role: "user", content: "anchor" }]);
	});
	test("anchorPayloadMessages mirrors block content", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "real" }] },
		];
		const next = anchorPayloadMessages(messages, "anchor");
		assert.deepStrictEqual(next, [
			{ role: "user", content: [{ type: "text", text: "anchor" }] },
		]);
	});
	test("anchorPayloadMessages keeps non-user messages and other fields", () => {
		const messages = [
			{ role: "system", content: "s" },
			{ role: "user", content: "real", extra: 1 },
		];
		const next = anchorPayloadMessages(messages, "anchor");
		assert.deepStrictEqual(next, [
			{ role: "system", content: "s" },
			{ role: "user", content: "anchor", extra: 1 },
		]);
	});
	test("anchorPayloadMessages returns undefined without a user message", () => {
		assert.equal(
			anchorPayloadMessages([{ role: "system", content: "s" }], "anchor"),
			undefined,
		);
		assert.equal(anchorPayloadMessages(undefined, "anchor"), undefined);
	});
});

describe("zeroAnchorPayload", () => {
	const payload = {
		model: "deepseek/deepseek-v4-flash",
		messages: [{ role: "user", content: "real question" }],
		tools: [{ type: "function", function: { name: "bash" } }],
	};

	test("strips all tools and anchors the first request on the anchor turn", () => {
		const { payload: out, anchored } = zeroAnchorPayload(
			payload,
			ANCHOR_TEXT,
		);
		assert.equal(anchored, true);
		assert.deepStrictEqual(out?.tools, []);
		assert.deepStrictEqual(out?.messages, [
			{ role: "user", content: ANCHOR_TEXT },
		]);
		assert.equal(out?.model, "deepseek/deepseek-v4-flash"); // rest of payload preserved
	});
	test("payload without a user message still loses its tools", () => {
		const { payload: out } = zeroAnchorPayload(
			{ tools: [{ type: "function", function: { name: "bash" } }] },
			ANCHOR_TEXT,
		);
		assert.deepStrictEqual(out?.tools, []);
		assert.equal(out?.messages, undefined);
	});
	test("undefined payload is not anchored", () => {
		const { payload: out, anchored } = zeroAnchorPayload(
			undefined,
			ANCHOR_TEXT,
		);
		assert.equal(anchored, false);
		assert.equal(out, undefined);
	});
});

describe("rewriteSystemPrompt", () => {
	test("exports the byte-identical DSH minimal persona", () => {
		assert.equal(
			MINIMAL_SYSTEM_PROMPT,
			"You are a helpful software engineer assistant.",
		);
	});
	test("rewrites an Anthropic-style top-level system string", () => {
		const { changed, payload } = rewriteSystemPrompt(
			{ system: "host prompt", model: "x" },
			MINIMAL_SYSTEM_PROMPT,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, {
			system: MINIMAL_SYSTEM_PROMPT,
			model: "x",
		});
	});
	test("rewrites an OpenAI-style leading system message", () => {
		const { changed, payload } = rewriteSystemPrompt(
			{
				messages: [
					{ role: "system", content: "host prompt" },
					{ role: "user", content: "hi" },
				],
			},
			MINIMAL_SYSTEM_PROMPT,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, {
			messages: [
				{ role: "system", content: MINIMAL_SYSTEM_PROMPT },
				{ role: "user", content: "hi" },
			],
		});
	});
	test("rewrites a leading developer message", () => {
		const { changed } = rewriteSystemPrompt(
			{ messages: [{ role: "developer", content: "host" }] },
			MINIMAL_SYSTEM_PROMPT,
		);
		assert.equal(changed, true);
	});
	test("is a no-op when the persona is already present", () => {
		assert.equal(
			rewriteSystemPrompt(
				{ system: MINIMAL_SYSTEM_PROMPT },
				MINIMAL_SYSTEM_PROMPT,
			).changed,
			false,
		);
		assert.equal(
			rewriteSystemPrompt(
				{
					messages: [
						{ role: "system", content: MINIMAL_SYSTEM_PROMPT },
					],
				},
				MINIMAL_SYSTEM_PROMPT,
			).changed,
			false,
		);
	});
	test("leaves non-object and non-system payloads untouched", () => {
		assert.equal(rewriteSystemPrompt(null, "t").changed, false);
		assert.equal(rewriteSystemPrompt("str", "t").changed, false);
		assert.equal(
			rewriteSystemPrompt(
				{ messages: [{ role: "user", content: "hi" }] },
				"t",
			).changed,
			false,
		);
	});
	test("never touches non-string system content", () => {
		assert.equal(
			rewriteSystemPrompt(
				{ messages: [{ role: "system", content: [{ type: "text" }] }] },
				"t",
			).changed,
			false,
		);
	});
});

describe("capMaxTokens", () => {
	test("caps max_tokens during bootstrap", () => {
		const { changed, payload } = capMaxTokens(
			{ max_tokens: 384000 },
			1024,
			false,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, { max_tokens: 1024 });
	});
	test("caps max_completion_tokens during bootstrap", () => {
		const { changed, payload } = capMaxTokens(
			{ max_completion_tokens: 64000 },
			1024,
			false,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, { max_completion_tokens: 1024 });
	});
	test("is a no-op when the cap is already set", () => {
		assert.equal(
			capMaxTokens({ max_tokens: 1024 }, 1024, false).changed,
			false,
		);
	});
	test("strips the injected cap after promotion", () => {
		const { changed, payload } = capMaxTokens(
			{ max_tokens: 1024 },
			1024,
			true,
		);
		assert.equal(changed, true);
		assert.deepStrictEqual(payload, {});
	});
	test("preserves a different value after promotion", () => {
		const { changed, payload } = capMaxTokens(
			{ max_tokens: 4096 },
			1024,
			true,
		);
		assert.equal(changed, false);
		assert.deepStrictEqual(payload, { max_tokens: 4096 });
	});
	test("no max-token field is untouched", () => {
		assert.equal(capMaxTokens({ model: "x" }, 1024, false).changed, false);
	});
	test("undefined cap is a no-op in both phases", () => {
		assert.equal(
			capMaxTokens({ max_tokens: 384000 }, undefined, false).changed,
			false,
		);
		assert.equal(
			capMaxTokens({ max_tokens: 1024 }, undefined, true).changed,
			false,
		);
	});
});

describe("isPositiveInt", () => {
	test("accepts positive safe integers", () => {
		assert.equal(isPositiveInt(1024), true);
		assert.equal(isPositiveInt(1), true);
	});
	test("rejects non-positive, non-integer, and non-number values", () => {
		assert.equal(isPositiveInt(0), false);
		assert.equal(isPositiveInt(-1), false);
		assert.equal(isPositiveInt(1.5), false);
		assert.equal(isPositiveInt("1024"), false);
		assert.equal(isPositiveInt(undefined), false);
	});
});

describe("stripContextMessages", () => {
	test("drops injected context, keeps system + last user", () => {
		const messages = [
			{ role: "system", content: "host prompt" },
			{ role: "user", content: "AGENTS.md digest" },
			{ role: "user", content: "real task" },
		];
		const stripped = stripContextMessages(messages);
		assert.ok(stripped);
		assert.equal(stripped.length, 2);
		assert.equal(stripped[0]!.role, "system");
		assert.equal(stripped[1]!.content, "real task");
	});
	test("no-op when no user message", () => {
		assert.equal(
			stripContextMessages([{ role: "system", content: "x" }]),
			undefined,
		);
	});
	test("no-op once a reply exists (not the first request)", () => {
		const messages = [
			{ role: "system", content: "x" },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "yo" },
			{ role: "user", content: "again" },
		];
		assert.equal(stripContextMessages(messages), undefined);
	});
	test("no-op when already minimal [system, user]", () => {
		const messages = [
			{ role: "system", content: MINIMAL_SYSTEM_PROMPT },
			{ role: "user", content: "hi" },
		];
		assert.equal(stripContextMessages(messages), undefined);
	});
	test("keeps developer role as the system prompt", () => {
		const messages = [
			{ role: "developer", content: "x" },
			{ role: "user", content: "hi" },
			{ role: "user", content: "extra context" },
		];
		const stripped = stripContextMessages(messages);
		assert.ok(stripped);
		assert.equal(stripped[0]!.role, "developer");
		assert.equal(stripped[1]!.content, "extra context");
	});

	test("empty suppressedSources disables the filter", () => {
		const messages = [
			{ role: "system", content: "host" },
			{ role: "user", content: "AGENTS.md" },
			{ role: "user", content: "real task" },
		];
		assert.equal(stripContextMessages(messages, []), undefined);
	});

	test("filters by source.kind when messages carry it", () => {
		const messages = [
			{ role: "system", content: "s" },
			{
				role: "user",
				content: "workspace digest",
				source: { kind: "agent-instructions" },
			},
			{ role: "user", content: "real task", source: { kind: "user" } },
		];
		const stripped = stripContextMessages(messages);
		assert.deepStrictEqual(stripped, [
			{ role: "system", content: "s" },
			{ role: "user", content: "real task", source: { kind: "user" } },
		]);
	});
});

describe("trajectory", () => {
	test("countTrajectory counts the fingerprint words", () => {
		assert.deepStrictEqual(countTrajectory("we need let me check"), {
			letMe: 1,
			we: 1,
			lets: 0,
		});
		assert.deepStrictEqual(countTrajectory("let's do it, let's go"), {
			letMe: 0,
			we: 0,
			lets: 2,
		});
	});
	test("trajectoryTextFromMessage joins thinking and text", () => {
		assert.equal(
			trajectoryTextFromMessage({
				content: [
					{ type: "thinking", thinking: "we need" },
					{ type: "text", text: "let me" },
				],
			}),
			"we need let me ",
		);
	});
	test("addTrajectory sums counts", () => {
		assert.deepStrictEqual(
			addTrajectory(
				{ letMe: 1, we: 2, lets: 3 },
				{ letMe: 4, we: 5, lets: 6 },
			),
			{ letMe: 5, we: 7, lets: 9 },
		);
	});
});
