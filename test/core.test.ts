import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	ANCHOR_TEXT,
	anchorContent,
	anchorPayloadMessages,
	applyDefaults,
	deepMerge,
	extractRaw,
	filterTools,
	hasAssistantMessage,
	hasToolCallHistory,
	isPromoted,
	isSubagentSession,
	lastUserIndex,
	matchGlob,
	modelMatches,
	resolveBootstrap,
	toolName,
	zeroAnchorPayload,
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
		models: [],
		bootstrapTools: ["bash", "read"],
		notify: true,
		bootstrapMode: "two-tool",
		promoteOn: "either",
		anchorText: ANCHOR_TEXT,
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
		});
		assert.deepStrictEqual(cfg, {
			enabled: false,
			models: ["a"],
			bootstrapTools: ["bash"],
			notify: false,
			bootstrapMode: "zero",
			promoteOn: "tool-call",
			anchorText: "custom",
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
	test("empty anchorText falls back to the default anchor", () => {
		assert.equal(applyDefaults({ anchorText: "" }).anchorText, ANCHOR_TEXT);
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
