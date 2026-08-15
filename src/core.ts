/**
 * Pure logic for the anchored-tools extension. No host imports (neither omp
 * nor pi), so this is unit-testable in isolation and shared by both entry
 * points (`src/omp.ts`, `src/pi.ts`).
 *
 * Port of the dsh-anchored-standard bootstrap concept
 * (https://github.com/xiaobright/dsh-anchored-standard): keep the first model
 * request on a small tool surface, promote to the full catalog after the
 * session's first durable promotion signal. The pi port is
 * (https://github.com/dbydd/pi-anchored-tool-for-dspro); the pure helpers
 * below mirror that implementation's semantics exactly, extended with the
 * upstream "zero-tool anchor" mode (zero-anchored-standard) and the
 * `promoteOn` trigger selector.
 */

export interface ToolLike {
	name?: string;
	type?: string;
	function?: { name?: string };
	custom?: { name?: string };
}

/** Extract a tool name from any provider payload shape. */
export function toolName(t: ToolLike): string | undefined {
	if (t.type === "function" && t.function?.name) return t.function.name;
	if (t.type === "custom" && t.custom?.name) return t.custom.name;
	return t.name;
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge with the hosts' exact settings semantics (see the pi port and
 * omp's settings docs): nested plain objects merge recursively, arrays are
 * replaced wholesale (never concatenated), undefined overrides are skipped.
 * Project-level (overrides) values win over global (base) values.
 */
export function deepMerge(base: unknown, overrides: unknown): unknown {
	if (!isMergeableObject(overrides)) {
		return overrides === undefined ? base : overrides;
	}
	if (!isMergeableObject(base)) {
		return structuredClone(overrides);
	}
	const result: Record<string, unknown> = { ...base };
	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) continue;
		result[key] =
			isMergeableObject(result[key]) && isMergeableObject(overrideValue)
				? deepMerge(result[key], overrideValue)
				: overrideValue;
	}
	return result;
}

/** Minimal '*' glob match (case-insensitive). Non-glob patterns compare exactly. */
export function matchGlob(pattern: string, value: string): boolean {
	const p = pattern.toLowerCase();
	const v = value.toLowerCase();
	if (p === "*") return true;
	if (!p.includes("*")) return p === v;
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

/**
 * Does this model match any configured pattern?
 * Patterns containing "/" match "provider/modelId"; bare patterns match
 * either "provider/modelId" or the bare modelId.
 */
export function modelMatches(
	modelId: string,
	provider: string,
	patterns: string[],
): boolean {
	if (patterns.length === 0) return false;
	const qualified = `${provider}/${modelId}`;
	return patterns.some((p) =>
		p.includes("/")
			? matchGlob(p, qualified)
			: matchGlob(p, qualified) || matchGlob(p, modelId),
	);
}

export interface EntryLike {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		content?: Array<{ type?: string }> | string;
	};
}

/**
 * True when the session already contains a durable tool call. Duck-typed so
 * it works on both omp's `sessionManager.getBranch()` entries (SessionEntry
 * union: `{ type: "message", message: AgentMessage }`) and pi's
 * `sessionManager.buildContextEntries()` output.
 */
export function hasToolCallHistory(entries: EntryLike[]): boolean {
	return entries.some((e) => {
		const m = e.message;
		if (!m) return false;
		if (m.role === "toolResult") return true;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			return m.content.some((c) => c?.type === "toolCall");
		}
		return false;
	});
}

/** True when the session already contains any durable assistant message. */
export function hasAssistantMessage(entries: EntryLike[]): boolean {
	return entries.some((e) => e.message?.role === "assistant");
}

/**
 * True when the session is a subagent (task) session. omp writes a
 * `session_init` entry for agent sessions; pi's session model has no such
 * entry, so this is a no-op there (pi subagents are anchored like everything
 * else).
 */
export function isSubagentSession(entries: EntryLike[]): boolean {
	return entries.some((e) => e.type === "session_init");
}

export type PromoteOn = "tool-call" | "assistant-message" | "either";

export function isPromoteOn(value: unknown): value is PromoteOn {
	return (
		value === "tool-call" ||
		value === "assistant-message" ||
		value === "either"
	);
}

/**
 * Whether the session has reached the promoted (full-catalog) phase, per the
 * configured trigger. Matches upstream's `PROMOTE_EVENTS`:
 *  - tool-call:         first durable tool call
 *  - assistant-message: first durable assistant message
 *  - either (default):  whichever comes first
 */
export function isPromoted(
	entries: EntryLike[],
	promoteOn: PromoteOn,
): boolean {
	if (promoteOn === "tool-call") return hasToolCallHistory(entries);
	if (promoteOn === "assistant-message") return hasAssistantMessage(entries);
	return hasToolCallHistory(entries) || hasAssistantMessage(entries);
}

export interface FilterResult {
	/** True when the payload was modified. */
	changed: boolean;
	tools: ToolLike[];
	/** Bootstrap tools absent from the catalog (configuration error). */
	missing: string[];
}

/**
 * Resolve the bootstrap tool names against the currently active catalog.
 * Fails safe: if any configured bootstrap tool is absent, returns `tools: []`
 * with the missing names so the caller can warn and skip narrowing instead of
 * stripping tools silently.
 */
export function resolveBootstrap(
	fullTools: string[],
	bootstrapTools: string[],
): { tools: string[]; missing: string[] } {
	const available = new Set(fullTools);
	const missing = bootstrapTools.filter((n) => !available.has(n));
	if (missing.length > 0) return { tools: [], missing };
	return { tools: [...new Set(bootstrapTools)], missing: [] };
}

/**
 * Filter a serialized provider tool catalog down to the bootstrap set.
 * Fails safe: if a required bootstrap tool is missing from the catalog,
 * returns `changed: false` and reports the missing names instead of
 * silently dropping the model's tools.
 */
export function filterTools(
	payloadTools: ToolLike[] | undefined,
	bootstrap: string[],
): FilterResult {
	if (!Array.isArray(payloadTools) || payloadTools.length === 0) {
		return { changed: false, tools: payloadTools ?? [], missing: [] };
	}
	const available = new Set(payloadTools.map((t) => toolName(t)));
	const missing = bootstrap.filter((n) => !available.has(n));
	if (missing.length > 0) {
		return { changed: false, tools: payloadTools, missing };
	}
	const filtered = payloadTools.filter((t) =>
		bootstrap.includes(toolName(t) ?? ""),
	);
	const changed = filtered.length !== payloadTools.length;
	return { changed, tools: changed ? filtered : payloadTools, missing: [] };
}

/** One serialized chat message inside a provider payload. */
export interface PayloadMessage {
	role?: string;
	content?: unknown;
}

/** Index of the last user message in a payload messages array, or -1. */
export function lastUserIndex(messages: PayloadMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

/**
 * Mirror the content shape of the message the anchor is appended after:
 * string user content stays a string, block content becomes a single text
 * block. Falls back to a string for anything else.
 */
export function anchorContent(
	anchorText: string,
	lastUserContent: unknown,
): string | { type: "text"; text: string }[] {
	if (typeof lastUserContent === "string") return anchorText;
	if (Array.isArray(lastUserContent))
		return [{ type: "text", text: anchorText }];
	return anchorText;
}

/**
 * Zero-mode first-request anchor: replace the last user message's content
 * with the anchor text, so the first request carries only the anchor turn
 * (the real message stays persisted in the session and is answered when the
 * conversation continues, matching upstream's "real message proceeds next
 * round"). Returns the new messages array, or undefined when there is no
 * user message to anchor (the caller then leaves messages untouched).
 */
export function anchorPayloadMessages(
	messages: PayloadMessage[] | undefined,
	anchorText: string,
): PayloadMessage[] | undefined {
	if (!Array.isArray(messages) || messages.length === 0) return undefined;
	const idx = lastUserIndex(messages);
	if (idx < 0) return undefined;
	const next = messages.slice();
	const last = messages[idx];
	next[idx] = { ...last, content: anchorContent(anchorText, last?.content) };
	return next;
}

/**
 * Zero-mode first-request transform: strip the whole tool catalog and anchor
 * the first request on the fixed anchor turn (last user message content is
 * replaced with the anchor text). Returns the rewritten payload plus whether
 * the payload was actually modified.
 */
export function zeroAnchorPayload(
	payload: Record<string, unknown> | undefined,
	anchorText: string,
): {
	payload: Record<string, unknown> | undefined;
	anchored: boolean;
} {
	if (!payload || typeof payload !== "object") {
		return { payload: undefined, anchored: false };
	}
	const messages = anchorPayloadMessages(
		payload.messages as PayloadMessage[] | undefined,
		anchorText,
	);
	const next: Record<string, unknown> = { ...payload, tools: [] };
	if (messages) next.messages = messages;
	return { payload: next, anchored: true };
}

export type BootstrapMode = "two-tool" | "zero";

export function isBootstrapMode(value: unknown): value is BootstrapMode {
	return value === "two-tool" || value === "zero";
}

/** Resolved extension configuration. */
export interface Config {
	enabled: boolean;
	models: string[];
	bootstrapTools: string[];
	notify: boolean;
	bootstrapMode: BootstrapMode;
	promoteOn: PromoteOn;
	anchorText: string;
}

/** Raw `anchoredTools` block as read from the host settings file. */
export interface RawConfig {
	enabled?: boolean;
	models?: string[];
	bootstrapTools?: string[];
	notify?: boolean;
	bootstrapMode?: unknown;
	promoteOn?: unknown;
	anchorText?: string;
}

/** Fixed anchor text from upstream zero-anchored-standard (config-overridable). */
export const ANCHOR_TEXT =
	"This round is a test. Tools are not open yet; all tools will open next round.";

export const DEFAULTS: Config = {
	enabled: true,
	models: [],
	bootstrapTools: ["bash", "read"],
	notify: true,
	bootstrapMode: "two-tool",
	promoteOn: "either",
	anchorText: ANCHOR_TEXT,
};

/**
 * Extract the `anchoredTools` block from a parsed settings root. A missing
 * or non-object value yields an empty raw config.
 */
export function extractRaw(
	root: Record<string, unknown> | undefined,
): RawConfig {
	const value = root?.anchoredTools;
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RawConfig)
		: {};
}

/**
 * Apply defaults to a raw config. Arrays are deduplicated; an empty
 * `bootstrapTools` array falls back to the default (a configured empty list
 * would otherwise strip every tool on the first request). Invalid
 * `bootstrapMode`/`promoteOn` values normalize to their defaults.
 */
export function applyDefaults(raw: RawConfig): Config {
	return {
		enabled: raw.enabled ?? DEFAULTS.enabled,
		models: Array.isArray(raw.models)
			? [...new Set(raw.models)]
			: DEFAULTS.models,
		bootstrapTools:
			Array.isArray(raw.bootstrapTools) && raw.bootstrapTools.length > 0
				? [...new Set(raw.bootstrapTools)]
				: DEFAULTS.bootstrapTools,
		notify: raw.notify ?? DEFAULTS.notify,
		bootstrapMode: isBootstrapMode(raw.bootstrapMode)
			? raw.bootstrapMode
			: DEFAULTS.bootstrapMode,
		promoteOn: isPromoteOn(raw.promoteOn)
			? raw.promoteOn
			: DEFAULTS.promoteOn,
		anchorText:
			typeof raw.anchorText === "string" && raw.anchorText.length > 0
				? raw.anchorText
				: DEFAULTS.anchorText,
	};
}
