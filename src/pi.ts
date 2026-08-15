/**
 * anchored-tools — pi entry point.
 *
 * Direct adaptation of dbydd/pi-anchored-tool-for-dspro's index.ts, with the
 * config defaults/merge helpers hoisted into src/core.ts for sharing with the
 * omp entry (src/omp.ts), plus the upstream zero-tool anchor mode, the
 * `promoteOn` trigger selector, the permanent minimal persona, and the
 * first-request output-budget cap (`bootstrapMaxTokens`).
 *
 * DeepSeek V4 Pro conditions strongly on the API-visible tool catalog: the
 * official Standard/PTC presets scored 91/92 on Project2 while Minimal scored
 * 99/96 — but Minimal only exposes two tools. This extension replicates the
 * two-phase "anchored standard" preset
 * (https://github.com/xiaobright/dsh-anchored-standard):
 *   1. For a configured target model, the FIRST provider request exposes only
 *      the bootstrap catalog (default: `bash` + `read`), or zero tools with a
 *      fixed anchor turn in `bootstrapMode: "zero"`, and its output budget is
 *      capped at `bootstrapMaxTokens` (default 1024).
 *   2. After the session's first durable promotion signal (per `promoteOn`),
 *      every later request exposes the full catalog and the normal budget.
 *
 * The phase is derived from session entries, so /resume and /reload preserve
 * it, exactly like the DSH preset derives promotion from durable session
 * events. Non-target models are never touched.
 *
 * Config lives in pi's settings.json under the top-level "anchoredTools" key,
 * following pi's own multi-level override semantics: the global settings file
 * (~/.pi/agent/settings.json) is the base, and a trusted project's
 * .pi/settings.json deep-merges over it (nested objects merge recursively,
 * arrays are replaced wholesale, project wins).
 *
 *   {
 *     "anchoredTools": {
 *       "enabled": true,
 *       "models": ["deepseek-v4-pro"],       // glob patterns; "provider/modelId" or bare modelId
 *       "bootstrapTools": ["bash", "read"],  // two-tool mode only
 *       "bootstrapMode": "two-tool",         // "two-tool" | "zero"
 *       "promoteOn": "either",               // "tool-call" | "assistant-message" | "either"
 *       "minimalSystemPrompt": true,         // system prompt → DSH minimal persona (permanent)
 *       "bootstrapMaxTokens": 1024,          // first-request output-budget cap
 *       "anchorText": "This round is a test. Tools are not open yet; all tools will open next round.",
 *     }
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	applyDefaults,
	capMaxTokens,
	classifyTask,
	deepMerge,
	extractRaw,
	filterTools,
	isBootstrapMode,
	isPositiveInt,
	isPromoteOn,
	isPromoted,
	isSubagentSession,
	memoizedIsPromoted,
	MINIMAL_SYSTEM_PROMPT,
	modelMatches,
	rewriteSystemPrompt,
	routerPersonaFor,
	selectBootstrapTools,
	SessionPromotionMemo,
	taskTextFromEntries,
	taskTextFromMessages,
	toolName,
	zeroAnchorPayload,
	type Config,
	type EntryLike,
	type PayloadMessage,
	type RawConfig,
	type ToolLike,
} from "./core";

const EXT_NAME = "anchored-tools";

function readSettingsJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch (err) {
		console.warn(`[${EXT_NAME}] failed to parse ${path}: ${err}; ignoring`);
		return undefined;
	}
}

/** Global settings as base; trusted project settings deep-merge over it. */
function loadConfig(
	ctx: { cwd: string; isProjectTrusted(): boolean },
	warn: (message: string) => void,
): Config {
	const globalRaw = extractRaw(
		readSettingsJson(join(getAgentDir(), "settings.json")),
	);
	let merged: RawConfig = globalRaw;
	if (ctx.isProjectTrusted()) {
		const projectRaw = extractRaw(
			readSettingsJson(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")),
		);
		merged = deepMerge(globalRaw, projectRaw) as RawConfig;
	}
	if (
		merged.bootstrapMode !== undefined &&
		!isBootstrapMode(merged.bootstrapMode)
	) {
		warn(
			`[${EXT_NAME}] invalid bootstrapMode ${JSON.stringify(merged.bootstrapMode)}; using "two-tool"`,
		);
	}
	if (merged.promoteOn !== undefined && !isPromoteOn(merged.promoteOn)) {
		warn(
			`[${EXT_NAME}] invalid promoteOn ${JSON.stringify(merged.promoteOn)}; using "either"`,
		);
	}
	if (
		merged.bootstrapMaxTokens !== undefined &&
		!isPositiveInt(merged.bootstrapMaxTokens)
	) {
		warn(
			`[${EXT_NAME}] invalid bootstrapMaxTokens ${JSON.stringify(merged.bootstrapMaxTokens)}; using 1024`,
		);
	}
	return applyDefaults(merged);
}

export default function (pi: ExtensionAPI) {
	// Per-session: was the first request actually anchored (catalog filtered)?
	const anchoredSessions = new Map<string, boolean>();
	const notified = new Set<string>();
	// Sessions that already logged the one-time system-prompt rewrite notice.
	const spLogged = new Set<string>();
	// Sessions already known promoted (append-only memo; avoids rescanning).
	const promotionMemo = new SessionPromotionMemo();

	const isTarget = (
		model: { id: string; provider: string } | undefined,
		cfg: Config,
	): boolean =>
		!!model &&
		cfg.enabled &&
		modelMatches(model.id, model.provider, cfg.models);

	/** One-time promotion notice for a session we actually anchored. */
	const maybeNotifyPromoted = (
		sid: string | undefined,
		modelId: string,
		cfg: Config,
		ctx: {
			ui: {
				notify(
					message: string,
					type?: "info" | "warning" | "error",
				): void;
			};
		},
	) => {
		if (
			!sid ||
			!cfg.notify ||
			!anchoredSessions.get(sid) ||
			notified.has(sid)
		)
			return;
		notified.add(sid);
		ctx.ui.notify(
			`[${EXT_NAME}] ${modelId}: session promoted — full tool catalog restored.`,
			"info",
		);
	};

	pi.on("before_provider_request", (event, ctx) => {
		const cfg = loadConfig(ctx, console.warn);
		if (!cfg.enabled || cfg.models.length === 0) return;
		if (!isTarget(ctx.model, cfg)) return;

		const sid = ctx.sessionManager.getSessionId();
		const promoteTrigger =
			cfg.bootstrapMode === "zero" ? "assistant-message" : cfg.promoteOn;
		let entries: EntryLike[] | undefined;
		const promoted = memoizedIsPromoted(
			promotionMemo,
			sid,
			promoteTrigger,
			() => {
				const branch = ctx.sessionManager.buildContextEntries();
				entries = branch;
				return branch;
			},
		);

		let payload = event.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object") return;
		let changed = false;

		const payloadMessages =
			(payload.messages as PayloadMessage[] | undefined) ?? [];
		const taskMode = classifyTask(taskTextFromMessages(payloadMessages));

		// The DSH persona replaces the host system prompt permanently (only
		// the tool catalog promotes). Task routing picks the measured optimum
		// persona for the classified task; otherwise the minimal persona is
		// used for every target model.
		if (cfg.minimalSystemPrompt) {
			const persona =
				cfg.taskRouting && cfg.bootstrapMode === "two-tool"
					? routerPersonaFor(taskMode, ctx.model!.id)
					: MINIMAL_SYSTEM_PROMPT;
			const sp = rewriteSystemPrompt(payload, persona);
			if (sp.changed) {
				payload = sp.payload as Record<string, unknown>;
				changed = true;
				if (sid && !spLogged.has(sid)) {
					spLogged.add(sid);
					console.log(
						`[${EXT_NAME}] ${ctx.model!.provider}/${ctx.model!.id}: system prompt → ` +
							(cfg.taskRouting && cfg.bootstrapMode === "two-tool"
								? `route persona (${taskMode})`
								: "DSH minimal persona"),
					);
				}
			}
		}

		if (cfg.bootstrapMode === "zero") {
			// The anchor reply promotes the session (assistant-message trigger).
			if (promoted) {
				if (sid) maybeNotifyPromoted(sid, ctx.model!.id, cfg, ctx);
				return changed ? payload : undefined;
			}
			// Subagents keep their full catalog from their very first request
			// (pi's context entries have no session_init; kept for parity with omp).
			if (isSubagentSession(entries ?? []))
				return changed ? payload : undefined;
			const result = zeroAnchorPayload(payload, cfg.anchorText);
			if (!result.payload) return changed ? payload : undefined;
			if (sid) anchoredSessions.set(sid, true);
			console.log(
				`[${EXT_NAME}] anchoring first request for ${ctx.model!.provider}/${ctx.model!.id}: ` +
					"0 tools (zero-tool anchor)",
			);
			return result.payload;
		}

		// two-tool mode
		if (promoted) {
			if (sid) maybeNotifyPromoted(sid, ctx.model!.id, cfg, ctx);
			// Strip the injected output-budget cap so the host default returns.
			const capped = capMaxTokens(payload, cfg.bootstrapMaxTokens, true);
			if (capped.changed) {
				payload = capped.payload;
				changed = true;
			}
			return changed ? payload : undefined;
		}

		// First request: cap the output budget before narrowing the catalog.
		const capped = capMaxTokens(payload, cfg.bootstrapMaxTokens, false);
		if (capped.changed) {
			payload = capped.payload;
			changed = true;
		}

		// Serialized tool catalog; selectBootstrapTools tries task-routing
		// first and falls back to the configured bootstrap tools.
		const tools = payload.tools as ToolLike[] | undefined;
		if (!Array.isArray(tools) || tools.length === 0)
			return changed ? payload : undefined;

		const available = tools
			.map((t) => toolName(t))
			.filter((n): n is string => typeof n === "string");
		const selected = selectBootstrapTools(cfg, taskMode, available);
		if (selected.missing.length > 0) {
			// Configuration error — fail safe, never strip tools silently.
			console.warn(
				`[${EXT_NAME}] bootstrap tools missing from catalog: ${selected.missing.join(", ")}; skipping filter`,
			);
			return changed ? payload : undefined;
		}
		const result = filterTools(tools, selected.tools);
		if (result.changed) {
			payload = { ...payload, tools: result.tools };
			changed = true;
			if (sid) anchoredSessions.set(sid, true);
			console.log(
				`[${EXT_NAME}] anchoring first request for ${ctx.model!.provider}/${ctx.model!.id}: ` +
					`${result.tools.length}/${tools.length} tools (${result.tools.map(toolName).join(", ")})` +
					(selected.used === "router"
						? ` [task-routing ${taskMode}]`
						: ""),
			);
		}

		return changed ? payload : undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		const cfg = loadConfig(ctx, console.warn);
		if (!isTarget(ctx.model, cfg) || !cfg.notify) return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !anchoredSessions.get(sid) || notified.has(sid)) return;
		notified.add(sid);
		ctx.ui.notify(
			`[${EXT_NAME}] ${ctx.model!.id}: first tool call recorded — full tool catalog restored.`,
			"info",
		);
	});

	pi.on("session_shutdown", () => {
		anchoredSessions.clear();
		notified.clear();
		spLogged.clear();
		promotionMemo.clear();
	});

	pi.registerCommand("anchored-tools", {
		description:
			"Show anchored tool bootstrap status (model targeting, current phase)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx, console.warn);
			const model = ctx.model;
			const matched = isTarget(model, cfg);
			const entries = ctx.sessionManager.buildContextEntries();
			const trigger =
				cfg.bootstrapMode === "zero"
					? "assistant-message"
					: cfg.promoteOn;
			const promoted = isPromoted(entries, trigger);
			const taskMode = classifyTask(taskTextFromEntries(entries));
			const phase = !cfg.enabled
				? "disabled"
				: !matched
					? "not-targeted"
					: promoted
						? "promoted (full catalog)"
						: cfg.bootstrapMode === "zero"
							? "bootstrap (zero-tool anchor)"
							: `bootstrap (${cfg.bootstrapTools.join(", ")} only)`;
			const lines = [
				`enabled: ${cfg.enabled}`,
				`mode: ${cfg.bootstrapMode}`,
				`promote on: ${cfg.promoteOn}`,
				`target models: ${cfg.models.join(", ") || "(none — no model is anchored)"}`,
				`task routing: ${cfg.taskRouting ? `on (task=${taskMode})` : "off"}`,
				`bootstrap tools: ${cfg.bootstrapTools.join(", ")}`,
				`bootstrap max tokens: ${cfg.bootstrapMaxTokens}`,
				`minimal system prompt: ${cfg.minimalSystemPrompt ? "on (DSH/route persona)" : "off (host default)"}`,
				`current model: ${model ? `${model.provider}/${model.id}` : "n/a"}`,
				`model matched: ${matched ? "yes" : "no"}`,
				`phase: ${phase}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
