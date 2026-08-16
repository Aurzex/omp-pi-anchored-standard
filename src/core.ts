/**
 * Pure logic for the anchored-tools extension. No host imports (neither omp
 * nor pi), so this is unit-testable in isolation and shared by both entry
 * points (`src/omp.ts`, `src/pi.ts`).
 *
 * Port of the dsh-anchored-standard bootstrap concept
 * (https://github.com/xiaobright/dsh-anchored-standard): keep the first model
 * request on a small tool surface, promote to the full catalog (or an optional
 * resident set) after the session's first durable promotion signal. The pi
 * port is (https://github.com/dbydd/pi-anchored-tool-for-dspro); the pure
 * helpers below mirror that implementation's semantics exactly, extended with
 * the upstream "zero-tool anchor" mode (zero-anchored-standard), the
 * `promoteOn` trigger selector, the permanent minimal persona (DSH `minimal`
 * preset), and the first-request output-budget cap (`bootstrapMaxTokens`,
 * upstream issue #6).
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

const GLOB_REGEX_CACHE = new Map<string, RegExp>();
const GLOB_REGEX_CACHE_MAX = 256;

/** Minimal '*' glob match (case-insensitive). Non-glob patterns compare exactly. */
export function matchGlob(pattern: string, value: string): boolean {
	const p = pattern.toLowerCase();
	if (p === "*") return true;
	if (!p.includes("*")) return p === value.toLowerCase();
	let re = GLOB_REGEX_CACHE.get(p);
	if (!re) {
		const escaped = p
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*");
		re = new RegExp(`^${escaped}$`, "i");
		GLOB_REGEX_CACHE.set(p, re);
		if (GLOB_REGEX_CACHE.size > GLOB_REGEX_CACHE_MAX) {
			const oldest = GLOB_REGEX_CACHE.keys().next().value;
			if (oldest !== undefined) GLOB_REGEX_CACHE.delete(oldest);
		}
	}
	return re.test(value);
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
		content?: Array<{ type?: string; text?: string }> | string;
	};
}

export type TaskMode = "spec" | "react" | "weak";

const REACT_RE =
	/(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi;
const SPEC_RE =
	/(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi;

function countMatches(re: RegExp, text: string): number {
	let count = 0;
	for (const _ of text.matchAll(re)) count++;
	return count;
}

/**
 * Task classifier ported from dsh-router-standard's `classifyTask`
 * (P1-P24): clear keyword evidence picks a stable band (react for
 * greenfield/build tasks, spec for maintenance/fix tasks); ambiguous or
 * unmatched text returns `weak`, the internal-routing mode where the model
 * decides per task.
 */
export function classifyTask(text: string): TaskMode {
	const react = countMatches(REACT_RE, text);
	const spec = countMatches(SPEC_RE, text);
	if (react > spec) return "react";
	if (spec > react) return "spec";
	return "weak";
}

/** True when the routed model id is a Flash-family model. */
export function isFlashModel(modelId: string): boolean {
	return typeof modelId === "string" && /flash/i.test(modelId);
}

/**
 * Task mode used by the task-aware router for a concrete model route.
 * Flash-family models always route `weak`: the measured optimum for Flash is
 * the static w7 persona + classify/recall/anti-runaway/deep-think anchors
 * (v4-flash-godmode-opencode-go, adapted from dsh-router-standard P11/P23),
 * and keyword evidence is noisier than the model-specific weak persona there.
 * Other models use the keyword classifier.
 */
export function routeTaskMode(text: string, modelId: string): TaskMode {
	return isFlashModel(modelId) ? "weak" : classifyTask(text);
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => {
			if (typeof c === "string") return c;
			if (c && typeof c === "object" && "text" in c) {
				const text = c.text;
				if (typeof text === "string") return text;
			}
			return "";
		})
		.join(" ");
}

/**
 * First durable user message text from host session entries, for the
 * task-aware routing decision. Empty when no user message is durable yet.
 */
export function taskTextFromEntries(entries: EntryLike[]): string {
	for (const e of entries) {
		const m = e.message;
		if (m?.role !== "user") continue;
		const text = contentToText(m.content);
		if (text.trim()) return text;
	}
	return "";
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

export interface PromotionPhase {
	/** Index of the last compaction entry, or -1 before any compaction. */
	boundary: number;
	/** True when a durable promotion signal exists after the boundary. */
	promoted: boolean;
}

function isToolCallEntry(e: EntryLike): boolean {
	const m = e.message;
	if (!m) return false;
	if (m.role === "toolResult") return true;
	if (m.role === "assistant" && Array.isArray(m.content)) {
		return m.content.some((c) => c?.type === "toolCall");
	}
	return false;
}

function isAssistantEntry(e: EntryLike): boolean {
	return e.message?.role === "assistant";
}

function isPromotionSignal(e: EntryLike, promoteOn: PromoteOn): boolean {
	if (promoteOn === "tool-call") return isToolCallEntry(e);
	if (promoteOn === "assistant-message") return isAssistantEntry(e);
	return isToolCallEntry(e) || isAssistantEntry(e);
}

/**
 * Epoch-aware promotion phase, ported from upstream `compaction-epoch.mjs`:
 * a compaction rewrites the model-visible surface, so only a durable
 * promotion signal recorded AFTER the last `compaction` entry counts as
 * promoted. Before any compaction the boundary is -1, which preserves the
 * original one-shot semantics.
 */
export function promotionPhase(
	entries: EntryLike[],
	promoteOn: PromoteOn,
): PromotionPhase {
	let boundary = -1;
	let promoted = false;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (!e) continue;
		if (e.type === "compaction") {
			boundary = i;
			promoted = false;
			continue;
		}
		if (!promoted && isPromotionSignal(e, promoteOn)) promoted = true;
	}
	return { boundary, promoted };
}

/**
 * Whether the session has reached the promoted (full-catalog) phase, per the
 * configured trigger. Matches upstream's `PROMOTE_EVENTS`:
 *  - tool-call:         first durable tool call
 *  - assistant-message: first durable assistant message
 *  - tool-call (default): first durable tool call
 *  - assistant-message:    first durable assistant message
 *  - either:               whichever comes first
 */
export function isPromoted(
	entries: EntryLike[],
	promoteOn: PromoteOn,
): boolean {
	return promotionPhase(entries, promoteOn).promoted;
}

/**
 * Promotion decisions are memoized per session for this process. A session
 * once found promoted stays promoted until the next compaction boundary —
 * the `session_compact` event resets the memo so the post-compaction request
 * is treated as a "second first request" (upstream `compaction-epoch.mjs`).
 */
export class SessionPromotionMemo {
	#sessions = new Set<string>();

	/** True when this session has already been recorded as promoted. */
	has(sid: string): boolean {
		return this.#sessions.has(sid);
	}

	/** Record a session as promoted. */
	add(sid: string): void {
		this.#sessions.add(sid);
	}

	/** Forget a session's promotion (compaction boundary). */
	delete(sid: string): void {
		this.#sessions.delete(sid);
	}

	clear(): void {
		this.#sessions.clear();
	}
}

/**
 * Memoized promotion-phase check. `getEntries` is called only when the
 * session has not already been recorded as promoted; on a memo hit the scan
 * is skipped and `{ boundary: -1, promoted: true }` is returned. A missing
 * session id disables the memo.
 */
export function memoizedPromotionPhase(
	memo: SessionPromotionMemo,
	sid: string | undefined,
	promoteOn: PromoteOn,
	getEntries: () => EntryLike[],
): PromotionPhase {
	if (sid && memo.has(sid)) return { boundary: -1, promoted: true };
	const phase = promotionPhase(getEntries(), promoteOn);
	if (phase.promoted && sid) memo.add(sid);
	return phase;
}

/**
 * Memoized promotion check. `getEntries` is called only when the session has
 * not already been recorded as promoted; on a memo hit the scan is skipped
 * and true is returned. A missing session id disables the memo.
 */
export function memoizedIsPromoted(
	memo: SessionPromotionMemo,
	sid: string | undefined,
	promoteOn: PromoteOn,
	getEntries: () => EntryLike[],
): boolean {
	return memoizedPromotionPhase(memo, sid, promoteOn, getEntries).promoted;
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
	const bootstrapSet = new Set(bootstrap);
	const missing = bootstrap.filter((n) => !available.has(n));
	if (missing.length > 0) {
		return { changed: false, tools: payloadTools, missing };
	}
	const filtered = payloadTools.filter((t) =>
		bootstrapSet.has(toolName(t) ?? ""),
	);
	const changed = filtered.length !== payloadTools.length;
	return { changed, tools: changed ? filtered : payloadTools, missing: [] };
}

/** One serialized chat message inside a provider payload. */
export interface PayloadMessage {
	role?: string;
	content?: unknown;
	source?: { kind?: string };
}

/** Index of the last user message in a payload messages array, or -1. */
export function lastUserIndex(messages: PayloadMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

/**
 * First user message text from a serialized provider payload, for the
 * task-aware routing decision. Empty when the payload has no user message.
 */
export function taskTextFromMessages(messages: PayloadMessage[]): string {
	for (const m of messages) {
		if (m?.role !== "user") continue;
		const text = contentToText(m.content);
		if (text.trim()) return text;
	}
	return "";
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

/** Automatic context sources stripped by default (upstream issue #11). */
export const DEFAULT_SUPPRESSED_SOURCES = [
	"skill-catalog",
	"agent-instructions",
];

/**
 * Strip auto-injected context from the FIRST request. This is the omp/pi
 * port of upstream `suppressedContextSources` (issue #11):
 *
 * - When messages carry `source.kind` (DSH-like payloads), filter exactly by
 *   the suppressed kinds — user-initiated skill gestures and other sources
 *   survive.
 * - When messages lack `source.kind` (omp/pi payloads), fall back to
 *   rebuilding the message list as `[system/developer, last user]`, so
 *   workspace instructions, AGENTS.md/CLAUDE.md digests, and the skill
 *   catalog never reach the first request.
 * - An empty `suppressedSources` array disables the filter while keeping the
 *   tool bootstrap.
 *
 * Returns undefined when there is nothing to strip: no user message, a
 * conversation that already contains an assistant/toolResult reply (not the
 * first request), or the filter is disabled.
 */
export function stripContextMessages(
	messages: PayloadMessage[] | undefined,
	suppressedSources: string[] = DEFAULT_SUPPRESSED_SOURCES,
): PayloadMessage[] | undefined {
	if (!Array.isArray(messages) || messages.length === 0) return undefined;
	if (suppressedSources.length === 0) return undefined;
	let userIdx = -1;
	let hasSourceKind = false;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		const r = m?.role;
		if (r === "assistant" || r === "toolResult" || r === "tool") {
			return undefined;
		}
		if (r === "user") userIdx = i;
		const kind = m?.source?.kind;
		if (typeof kind === "string" && kind.length > 0) hasSourceKind = true;
	}
	if (userIdx < 0) return undefined;

	if (hasSourceKind) {
		const kept = messages.filter((m) => {
			const kind = m?.source?.kind;
			return (
				typeof kind !== "string" || !suppressedSources.includes(kind)
			);
		});
		return kept.length === messages.length ? undefined : kept;
	}

	const systemIdx = messages.findIndex(
		(m) => m?.role === "system" || m?.role === "developer",
	);
	const kept: PayloadMessage[] = [];
	if (systemIdx >= 0) {
		const s = messages[systemIdx];
		if (s) kept.push(s);
	}
	const u = messages[userIdx];
	if (u) kept.push(u);
	if (kept.length === messages.length) return undefined; // nothing dropped
	return kept;
}

/** Word-frequency fingerprint from xiaobright/modeltest trajectory analysis. */
export interface TrajectoryCounts {
	letMe: number;
	we: number;
	lets: number;
}

const LET_ME_RE = /\blet me\b/gi;
const WE_RE = /\bwe\b/gi;
const LETS_RE = /\blet's\b/gi;

/** Count the `let me` / `we` / `let's` fingerprint across reasoning + text. */
export function countTrajectory(text: string): TrajectoryCounts {
	return {
		letMe: countMatches(LET_ME_RE, text),
		we: countMatches(WE_RE, text),
		lets: countMatches(LETS_RE, text),
	};
}

export function addTrajectory(
	a: TrajectoryCounts,
	b: TrajectoryCounts,
): TrajectoryCounts {
	return {
		letMe: a.letMe + b.letMe,
		we: a.we + b.we,
		lets: a.lets + b.lets,
	};
}

/**
 * Concatenate an assistant message's reasoning + visible text for trajectory
 * counting. Duck-typed so it works on both hosts' assistant message shapes.
 */
export function trajectoryTextFromMessage(message: {
	content?: unknown;
}): string {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (typeof b.thinking === "string") out += b.thinking + " ";
		if (typeof b.text === "string") out += b.text + " ";
	}
	return out;
}

/** DSH minimal-mode system prompt, byte-identical to the DeepSeek Harness
 * `minimal` preset persona (`complete: true` — the persona IS the entire
 * system prompt). This codex-style one-liner is the co-equal trajectory
 * anchor alongside the tool catalog: rewording it breaks the `We need`
 * reasoning style (xiaobright/modeltest trigger-mechanism experiments).
 * The byte string must not be invented or reworded. */
export const MINIMAL_SYSTEM_PROMPT =
	"You are a helpful software engineer assistant.";

/** Hands-on doer persona from dsh-router-standard's react band. */
export const REACT_PERSONA =
	"You are a hands-on software engineer who delivers working output fast.\n" +
	"Work directly: write or edit code, then verify it by reading and running. " +
	"Keep the loop tight — produce, verify, fix — and do not build test " +
	"harnesses, scaffolding, or ceremony the user did not ask for. " +
	"Finish with a usable deliverable and a short summary.";

/** Weak internal-routing persona for non-Flash models (dsh-router-standard w6c). */
export const WEAK_PRO_PERSONA =
	MINIMAL_SYSTEM_PROMPT +
	"\nBefore acting, decide the task type (build or fix) and adopt the matching " +
	"style: build → hands-on production; fix → inspect-and-plan.";

/**
 * Weak internal-routing persona for Flash-family models (dsh-router-standard
 * w7 + v4-flash-godmode-opencode-go static anchors). The deep-think /
 * decision-closure anchor is merged into the persona because omp/pi have no
 * DSH-style per-message inbox, so near-field guidance must be static — the
 * same adaptation the opencode-go Flash preset makes.
 */
export const WEAK_FLASH_PERSONA =
	"You are a helpful assistant.\n" +
	"Before acting, decide the task type (build or fix) and adopt the matching " +
	"style: build → hands-on production; fix → inspect-and-plan.\n" +
	"Before acting, briefly review what you have already done in this session " +
	"and continue from where you left off; do not repeat completed steps. Do not " +
	"run environment checks (echo, whoami, uname, node --version, date) or " +
	"exhaustive grep/glob scans.\n" +
	"Think deeply about the architecture, edge cases, and integration points " +
	"before writing. Do not spend reasoning on the environment or tooling. " +
	"Produce when your information is complete, and end each reasoning block " +
	"with a decision or an information need.";

/** Model-specific optimum persona for a classified task mode. */
export function routerPersonaFor(mode: TaskMode, modelId: string): string {
	switch (mode) {
		case "spec":
			return MINIMAL_SYSTEM_PROMPT;
		case "react":
			return REACT_PERSONA;
		case "weak":
			return isFlashModel(modelId)
				? WEAK_FLASH_PERSONA
				: WEAK_PRO_PERSONA;
	}
}

/**
 * First-turn core tools for a classified task mode, ported from
 * dsh-router-standard's `coreFor`: spec is read-first, react is write-first,
 * weak keeps the write-first default (the model routes internally while the
 * tool surface stays deterministic).
 */
export function routerBootstrapTools(mode: TaskMode): string[] {
	switch (mode) {
		case "spec":
			return ["read", "edit", "glob", "grep"];
		case "react":
			return ["read", "write", "edit"];
		case "weak":
			return ["read", "write", "edit"];
	}
}

/**
 * The platform shell present in the catalog, preferring `pwsh` (the measured
 * Windows-native optimum in dsh-router-standard's router-bootstrap) over
 * `bash`. Returns undefined when the catalog has neither.
 */
export function platformShell(available: string[]): string | undefined {
	return (
		available.find((n) => n === "pwsh") ??
		available.find((n) => n === "bash")
	);
}

/** Add the platform shell (`bash` or `pwsh`) to a bootstrap tool list. */
export function withPlatformShell(
	tools: string[],
	available: string[],
): string[] {
	const shell = platformShell(available);
	return shell ? [...tools, shell] : tools;
}

/**
 * Replace configured `bash`/`pwsh` entries with the platform shell that is
 * actually present, preserving order and deduplicating. Keeps the configured
 * bootstrap set portable across Linux/macOS/Windows catalogs.
 */
export function normalizeShellTools(
	tools: string[],
	available: string[],
): string[] {
	const shell = platformShell(available);
	if (!shell) return tools;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const tool of tools) {
		const name = tool === "bash" || tool === "pwsh" ? shell : tool;
		if (seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

/**
 * Resolve the first-request bootstrap tools for two-tool mode. Task routing
 * (dsh-router-standard) is tried first; when any router-selected tool is
 * missing from the catalog, the configured `bootstrapTools` are used as the
 * fallback, and only if those are missing too is the missing set reported
 * (the caller then fails safe without narrowing).
 *
 * After a compaction (`boundary >= 0`) the controlled phase additionally
 * exposes `compactionTools` so mid-task work can continue until a NEW durable
 * promotion signal exists past the boundary (upstream `compactionTools`).
 */
export function selectBootstrapTools(
	cfg: {
		bootstrapTools: string[];
		taskRouting: boolean;
		routerMode?: RouterMode;
		compactionTools?: string[];
	},
	mode: TaskMode,
	available: string[],
	boundary = -1,
): { tools: string[]; missing: string[]; used: "router" | "configured" } {
	const compactionTools = cfg.compactionTools ?? [];
	const configured = (): {
		tools: string[];
		missing: string[];
		used: "router" | "configured";
	} => {
		if (cfg.taskRouting) {
			// `standard` (upstream v0.2.0 default): RL-interface restore —
			// shell + str_replace_editor. `spec`: old deep-think-first
			// classification core.
			const desired = withPlatformShell(
				cfg.routerMode === "spec"
					? routerBootstrapTools(mode)
					: ["str_replace_editor"],
				available,
			);
			const routerResolved = resolveBootstrap(available, desired);
			if (routerResolved.missing.length === 0) {
				return {
					tools: routerResolved.tools,
					missing: [],
					used: "router",
				};
			}
		}
		const resolved = resolveBootstrap(
			available,
			normalizeShellTools(cfg.bootstrapTools, available),
		);
		return {
			tools: resolved.tools,
			missing: resolved.missing,
			used: "configured",
		};
	};

	const base = configured();
	if (base.missing.length > 0) return base;
	if (boundary >= 0 && compactionTools.length > 0) {
		const combined = resolveBootstrap(available, [
			...new Set([...base.tools, ...compactionTools]),
		]);
		if (combined.missing.length > 0) {
			return { tools: [], missing: combined.missing, used: base.used };
		}
		return { tools: combined.tools, missing: [], used: base.used };
	}
	return base;
}

/**
 * Zero-mode tool surface. The very first request (`boundary < 0`) carries no
 * tools at all. After a compaction the model is mid-task and needs to keep
 * working: if `compactionTools` is configured, expose the platform shells +
 * that work set; otherwise stay on the zero-tool surface until a new durable
 * assistant message promotes the session (upstream zero-tool-bootstrap).
 */
export function selectZeroBootstrapTools(
	available: string[],
	compactionTools: string[],
	boundary: number,
): { tools: string[]; missing: string[] } {
	if (boundary < 0 || compactionTools.length === 0) {
		return { tools: [], missing: [] };
	}
	const availableSet = new Set(available);
	const shells = available.filter((n) => n === "pwsh" || n === "bash");
	if (shells.length === 0) return { tools: [], missing: ["bash/pwsh"] };
	const missing = compactionTools.filter((n) => !availableSet.has(n));
	if (missing.length > 0) return { tools: [], missing };
	return {
		tools: [...new Set([...shells, ...compactionTools])],
		missing: [],
	};
}

/**
 * Post-promotion resident tool surface, ported from upstream
 * dsh-anchored-standard's "resident set" change. The default config now uses
 * a resident set (`DEFAULT_PROMOTED_TOOLS`); an explicitly empty
 * `promotedTools` preserves the original behavior and restores the full
 * catalog. Non-empty keeps only the listed tools after promotion (plus the
 * platform shell when a `bash`/`pwsh` entry is configured), so heavier tools
 * stay one explicit config change away instead of flooding the
 * post-promotion trajectory. Fails safe: missing tools report `missing` so
 * callers can warn and keep the full catalog.
 */
export function selectPromotedTools(
	available: string[],
	promotedTools: string[],
): { tools: string[]; missing: string[] } {
	if (promotedTools.length === 0) return { tools: [], missing: [] };
	const desired = normalizeShellTools(promotedTools, available);
	return resolveBootstrap(available, desired);
}

export interface SystemPromptRewrite {
	/** True when the payload was modified. */
	changed: boolean;
	/** Replacement payload — same reference when unchanged. */
	payload: unknown;
}

/**
 * Replace the harness-injected system prompt (the front of the context) with
 * the given persona text. Handles both serialized shapes the hosts produce:
 *
 * - OpenAI-compatible: `payload.messages[0]` with role `system`/`developer`
 * - Anthropic-style: top-level `payload.system` string
 *
 * Fails safe: if neither shape is present the payload is returned unchanged;
 * non-string system content (e.g. Anthropic block arrays) is never touched.
 */
export function rewriteSystemPrompt(
	payload: unknown,
	text: string,
): SystemPromptRewrite {
	if (typeof payload !== "object" || payload === null) {
		return { changed: false, payload };
	}
	const p = payload as Record<string, unknown>;

	if (typeof p.system === "string" && p.system !== text) {
		return { changed: true, payload: { ...p, system: text } };
	}

	const messages = p.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		return { changed: false, payload };
	}
	const first = messages[0];
	if (typeof first !== "object" || first === null) {
		return { changed: false, payload };
	}
	const m = first as Record<string, unknown>;
	if (m.role !== "system" && m.role !== "developer") {
		return { changed: false, payload };
	}
	if (typeof m.content !== "string" || m.content === text) {
		return { changed: false, payload };
	}
	return {
		changed: true,
		payload: {
			...p,
			messages: [{ ...m, content: text }, ...messages.slice(1)],
		},
	};
}

/** Wire field names a provider payload may carry for the output budget. */
const MAX_TOKENS_FIELDS = ["max_tokens", "max_completion_tokens"] as const;

/**
 * Cap the first request's output budget. The cap is OPT-IN (upstream issue
 * #11): the Minimal tool schema anchors the `We need` trajectory at the
 * adapter-default maxTokens, so `bootstrapMaxTokens` defaults to `undefined`
 * (no cap). When configured, the field is set to the cap during bootstrap and
 * the injected cap is stripped after promotion so the host default returns.
 * A different value is preserved. Returns the same reference when nothing
 * changed.
 */
export function capMaxTokens(
	payload: Record<string, unknown>,
	bootstrapMaxTokens: number | undefined,
	promoted: boolean,
): { changed: boolean; payload: Record<string, unknown> } {
	if (bootstrapMaxTokens === undefined) return { changed: false, payload };
	const field = MAX_TOKENS_FIELDS.find((f) => typeof payload[f] === "number");
	if (!field) return { changed: false, payload };
	if (promoted) {
		if (payload[field] === bootstrapMaxTokens) {
			const { [field]: _injected, ...rest } = payload;
			return { changed: true, payload: rest };
		}
		return { changed: false, payload };
	}
	if (payload[field] === bootstrapMaxTokens)
		return { changed: false, payload };
	return {
		changed: true,
		payload: { ...payload, [field]: bootstrapMaxTokens },
	};
}

export type BootstrapMode = "two-tool" | "zero";

export function isBootstrapMode(value: unknown): value is BootstrapMode {
	return value === "two-tool" || value === "zero";
}

export type RouterMode = "standard" | "spec";

export function isRouterMode(value: unknown): value is RouterMode {
	return value === "standard" || value === "spec";
}

/** True for a positive safe integer (bootstrapMaxTokens validation). */
export function isPositiveInt(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value > 0
	);
}

export interface Config {
	enabled: boolean;
	models: string[];
	bootstrapTools: string[];
	notify: boolean;
	bootstrapMode: BootstrapMode;
	promoteOn: PromoteOn;
	anchorText: string;
	minimalSystemPrompt: boolean;
	bootstrapMaxTokens: number | undefined;
	taskRouting: boolean;
	routerMode: RouterMode;
	suppressedContextSources: string[];
	compactionTools: string[];
	includeSubagents: boolean;
	promotedTools: string[];
}

/**
 * True when a currently narrowed omp session must be restored to the full
 * catalog even without a promotion signal: anchoring was disabled, the target
 * list is empty, or a known model is no longer targeted. Returns false for an
 * unknown model — `session_start` can fire before the model is known, and the
 * next hook with a model makes the decision.
 */
export function shouldRestoreFullCatalog(
	cfg: Config,
	model: { id: string; provider: string } | undefined,
): boolean {
	if (!cfg.enabled || cfg.models.length === 0) return true;
	if (model === undefined) return false;
	return !modelMatches(model.id, model.provider, cfg.models);
}

/** True when `model` is a target for anchoring under `cfg`. */
export function isTargetModel(
	cfg: Config,
	model: { id: string; provider: string } | undefined,
): boolean {
	return (
		!!model &&
		cfg.enabled &&
		modelMatches(model.id, model.provider, cfg.models)
	);
}

/**
 * Effective promotion trigger for a config. Zero-mode always promotes on the
 * first assistant message (the anchor reply), regardless of `promoteOn`.
 */
export function promoteTrigger(
	cfg: Pick<Config, "bootstrapMode" | "promoteOn">,
): PromoteOn {
	return cfg.bootstrapMode === "zero" ? "assistant-message" : cfg.promoteOn;
}

/** Every config key this extension accepts — anything else is a typo. */
export const ALLOWED_RAW_KEYS = [
	"enabled",
	"models",
	"bootstrapTools",
	"notify",
	"bootstrapMode",
	"promoteOn",
	"anchorText",
	"minimalSystemPrompt",
	"bootstrapMaxTokens",
	"taskRouting",
	"routerMode",
	"suppressedContextSources",
	"compactionTools",
	"includeSubagents",
	"promotedTools",
] as const;

function isNonEmptyStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((item) => typeof item === "string" && item.length > 0)
	);
}

/**
 * Warn about invalid raw config values once, with the same messages both host
 * entry points used to duplicate. Invalid values normalize in applyDefaults.
 */
export function validateRawConfig(
	raw: RawConfig,
	warn: (message: string) => void,
	extName: string,
): void {
	const unknown = Object.keys(raw).filter(
		(key) => !(ALLOWED_RAW_KEYS as readonly string[]).includes(key),
	);
	if (unknown.length > 0) {
		warn(
			`[${extName}] unknown anchoredTools key(s) ${unknown.join(", ")}; allowed keys: ${ALLOWED_RAW_KEYS.join(", ")}`,
		);
	}
	if (
		raw.bootstrapMode !== undefined &&
		!isBootstrapMode(raw.bootstrapMode)
	) {
		warn(
			`[${extName}] invalid bootstrapMode ${JSON.stringify(raw.bootstrapMode)}; using "two-tool"`,
		);
	}
	if (raw.promoteOn !== undefined && !isPromoteOn(raw.promoteOn)) {
		warn(
			`[${extName}] invalid promoteOn ${JSON.stringify(raw.promoteOn)}; using "either"`,
		);
	}
	if (raw.routerMode !== undefined && !isRouterMode(raw.routerMode)) {
		warn(
			`[${extName}] invalid routerMode ${JSON.stringify(raw.routerMode)}; using "standard"`,
		);
	}
	if (
		raw.bootstrapMaxTokens !== undefined &&
		!isPositiveInt(raw.bootstrapMaxTokens)
	) {
		warn(
			`[${extName}] invalid bootstrapMaxTokens ${JSON.stringify(raw.bootstrapMaxTokens)}; using no cap (default)`,
		);
	}
	if (
		raw.suppressedContextSources !== undefined &&
		!Array.isArray(raw.suppressedContextSources)
	) {
		warn(
			`[${extName}] invalid suppressedContextSources ${JSON.stringify(raw.suppressedContextSources)}; using default sources`,
		);
	} else if (
		Array.isArray(raw.suppressedContextSources) &&
		!isNonEmptyStringArray(raw.suppressedContextSources)
	) {
		warn(
			`[${extName}] suppressedContextSources must contain only non-empty strings; invalid entries ignored`,
		);
	}
	if (
		raw.compactionTools !== undefined &&
		!isNonEmptyStringArray(raw.compactionTools)
	) {
		warn(
			`[${extName}] invalid compactionTools ${JSON.stringify(raw.compactionTools)}; using no compaction work set (default)`,
		);
	}
	if (
		raw.promotedTools !== undefined &&
		!isNonEmptyStringArray(raw.promotedTools)
	) {
		warn(
			`[${extName}] invalid promotedTools ${JSON.stringify(raw.promotedTools)}; using full catalog after promotion (default)`,
		);
	}
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
	minimalSystemPrompt?: boolean;
	bootstrapMaxTokens?: number;
	taskRouting?: boolean;
	routerMode?: unknown;
	suppressedContextSources?: string[];
	compactionTools?: string[];
	includeSubagents?: boolean;
	promotedTools?: string[];
}

/** Fixed anchor text from upstream zero-anchored-standard (config-overridable). */
export const ANCHOR_TEXT =
	"This round is a test. Tools are not open yet; all tools will open next round.";

/**
 * Default post-promotion resident catalog.
 *
 * Upstream dsh-anchored-standard keeps the promoted phase on a small resident
 * set instead of dumping the full Standard catalog at once (measured
 * post-promotion regression). omp/pi have no DSH discovery tools
 * (`dev_tool_search`/`skill_search`/`skill_load`), so the portable equivalent
 * is the platform shell plus the common file-work set. Explicitly configuring
 * `promotedTools: []` still restores the full catalog.
 */
export const DEFAULT_PROMOTED_TOOLS = [
	"bash",
	"read",
	"edit",
	"glob",
	"grep",
] as const;

export const DEFAULTS: Config = {
	enabled: true,
	models: ["deepseek-v4-pro"],
	// The 98/99 anchored-standard runs on xiaobright/modeltest bootstrapped the
	// first request with the platform shell + read, not an editor; keep that
	// measured high-score surface as the zero-config default.
	bootstrapTools: ["bash", "read"],
	notify: true,
	bootstrapMode: "two-tool",
	// Upstream dsh-anchored-standard now defaults to `either`: request #1 sees
	// the bootstrap catalog and request #2 always sees the full/resident
	// catalog, so a text-only first reply cannot trap the session in
	// bootstrap. `tool-call` is still available for the original behavior.
	promoteOn: "either",
	anchorText: ANCHOR_TEXT,
	minimalSystemPrompt: true,
	bootstrapMaxTokens: undefined,
	taskRouting: false,
	// Upstream dsh-router-standard v0.2.0: `standard` = RL-interface restore
	// (minimal persona + shell/str_replace_editor first turn), `spec` = old
	// deep-think-first classification personas + read/write/edit core.
	routerMode: "standard",
	suppressedContextSources: [...DEFAULT_SUPPRESSED_SOURCES],
	compactionTools: [],
	includeSubagents: false,
	// Default = upstream's post-promotion resident-set behavior: keep only the
	// platform shell + common file-work tools after promotion. Explicitly
	// configured `[]` restores the full catalog (the original plugin promise).
	promotedTools: [...DEFAULT_PROMOTED_TOOLS],
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
			: [...DEFAULTS.models],
		bootstrapTools:
			Array.isArray(raw.bootstrapTools) && raw.bootstrapTools.length > 0
				? [...new Set(raw.bootstrapTools)]
				: [...DEFAULTS.bootstrapTools],
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
		minimalSystemPrompt:
			raw.minimalSystemPrompt ?? DEFAULTS.minimalSystemPrompt,
		bootstrapMaxTokens: isPositiveInt(raw.bootstrapMaxTokens)
			? raw.bootstrapMaxTokens
			: undefined,
		taskRouting: raw.taskRouting ?? DEFAULTS.taskRouting,
		routerMode: isRouterMode(raw.routerMode)
			? raw.routerMode
			: DEFAULTS.routerMode,
		suppressedContextSources: Array.isArray(raw.suppressedContextSources)
			? [
					...new Set(
						raw.suppressedContextSources.filter(
							(s): s is string =>
								typeof s === "string" && s.length > 0,
						),
					),
				]
			: [...DEFAULTS.suppressedContextSources],
		compactionTools: isNonEmptyStringArray(raw.compactionTools)
			? [...new Set(raw.compactionTools)]
			: [],
		includeSubagents: raw.includeSubagents ?? DEFAULTS.includeSubagents,
		promotedTools: Array.isArray(raw.promotedTools)
			? isNonEmptyStringArray(raw.promotedTools)
				? [...new Set(raw.promotedTools)]
				: []
			: [...DEFAULTS.promotedTools],
	};
}
