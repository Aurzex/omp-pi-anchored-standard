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
 *      optionally capped at `bootstrapMaxTokens` (unset = no cap).
 *   2. After the session's first durable promotion signal (per `promoteOn`),
 *      every later request exposes the full catalog (default) or the
 *      configured `promotedTools` resident set, and the normal budget.
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
 *       "bootstrapTools": ["bash", "read"],  // two-tool mode only (default)
 *       "routerMode": "standard",            // "standard" | "spec" (taskRouting=true 时生效)
 *       "bootstrapMode": "two-tool",         // "two-tool" | "zero"
 *       "promoteOn": "either",               // "tool-call" | "assistant-message" | "either"
 *       "minimalSystemPrompt": true,         // system prompt → DSH minimal persona (permanent)
 *       "bootstrapMaxTokens": 1024,          // optional cap; unset = no cap
 *       "anchorText": "This round is a test. Tools are not open yet; all tools will open next round.",
 *       "includeSubagents": false,           // anchor subagent sessions too when true
 *       "promotedTools": [],                 // post-promotion resident set; [] = full catalog
 *     }
 *   }
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	addTrajectory,
	applyDefaults,
	capMaxTokens,
	routeTaskMode,
	countTrajectory,
	deepMerge,
	extractRaw,
	filterTools,
	isSubagentSession,
	isTargetModel,
	memoizedPromotionPhase,
	MINIMAL_SYSTEM_PROMPT,
	promotionPhase,
	promoteTrigger,
	rewriteSystemPrompt,
	routerPersonaFor,
	selectBootstrapTools,
	selectPromotedTools,
	selectZeroBootstrapTools,
	SessionPromotionMemo,
	stripContextMessages,
	taskTextFromEntries,
	taskTextFromMessages,
	toolName,
	trajectoryTextFromMessage,
	validateRawConfig,
	zeroAnchorPayload,
	type Config,
	type EntryLike,
	type PayloadMessage,
	type RawConfig,
	type ToolLike,
	type TrajectoryCounts,
} from "./core";

const EXT_NAME = "anchored-tools";
const CONFIG_CACHE: Record<
	string,
	{ mtimeMs: number; size: number; data: Record<string, unknown> | undefined }
> = Object.create(null);

function readSettingsJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	const stat = statSync(path);
	const cached = CONFIG_CACHE[path];
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
		return cached.data;
	let data: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		data =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: undefined;
	} catch (err) {
		console.warn(`[${EXT_NAME}] failed to parse ${path}: ${err}; ignoring`);
		data = undefined;
	}
	CONFIG_CACHE[path] = { mtimeMs: stat.mtimeMs, size: stat.size, data };
	return data;
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
	validateRawConfig(merged, warn, EXT_NAME);
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
	// Per-session trajectory fingerprint (let me / we / let's) for /anchored-tools.
	const trajectory = new Map<string, TrajectoryCounts>();

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
			`[${EXT_NAME}] ${modelId}: session promoted — ${cfg.promotedTools.length > 0 ? "resident tool catalog applied." : "full tool catalog restored."}`,
			"info",
		);
	};

	pi.on("before_provider_request", (event, ctx) => {
		const cfg = loadConfig(ctx, console.warn);
		if (!cfg.enabled || cfg.models.length === 0) return;
		if (!isTargetModel(cfg, ctx.model)) return;
		const sid = ctx.sessionManager.getSessionId();
		const promoteOn = promoteTrigger(cfg);
		let entries: EntryLike[] | undefined;
		const phase = memoizedPromotionPhase(
			promotionMemo,
			sid,
			promoteOn,
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
		const needsTaskMode =
			cfg.taskRouting &&
			(cfg.bootstrapMode === "two-tool" ||
				(cfg.minimalSystemPrompt && cfg.routerMode === "spec"));
		const taskMode = needsTaskMode
			? routeTaskMode(
					taskTextFromMessages(payloadMessages),
					ctx.model!.id,
				)
			: "weak";

		// Apply the optional first-request output-budget cap (and strip it
		// after promotion) before any mode-specific branch. This keeps
		// `bootstrapMaxTokens` consistent for both two-tool and zero mode.
		const capped = capMaxTokens(
			payload,
			cfg.bootstrapMaxTokens,
			phase.promoted,
		);
		if (capped.changed) {
			payload = capped.payload;
			changed = true;
		}

		// The DSH persona replaces the host system prompt permanently (only
		// the tool catalog promotes). Task routing picks the measured optimum
		// persona for the classified task; otherwise the minimal persona is
		// used for every target model.
		if (cfg.minimalSystemPrompt) {
			const persona =
				cfg.taskRouting &&
				cfg.bootstrapMode === "two-tool" &&
				cfg.routerMode === "spec"
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
							(cfg.taskRouting &&
							cfg.bootstrapMode === "two-tool" &&
							cfg.routerMode === "spec"
								? `route persona (${taskMode})`
								: "DSH minimal persona"),
					);
				}
			}
		}

		// Promoted phase: the tool catalog is no longer bootstrapped. When
		// `promotedTools` is configured, keep only that resident set instead of
		// the full catalog (upstream dsh-anchored-standard post-promotion fix).
		if (phase.promoted) {
			if (cfg.promotedTools.length > 0) {
				const promotedTools = payload.tools as ToolLike[] | undefined;
				if (Array.isArray(promotedTools) && promotedTools.length > 0) {
					const available = promotedTools
						.map((t) => toolName(t))
						.filter((n): n is string => typeof n === "string");
					const selected = selectPromotedTools(
						available,
						cfg.promotedTools,
					);
					if (selected.missing.length > 0) {
						// Configuration error — fail safe, never strip tools.
						console.warn(
							`[${EXT_NAME}] promoted tools missing from catalog: ${selected.missing.join(", ")}; keeping full catalog`,
						);
					} else {
						const result = filterTools(
							promotedTools,
							selected.tools,
						);
						if (result.changed) {
							payload = { ...payload, tools: result.tools };
							changed = true;
						}
					}
				}
			}
			if (sid) maybeNotifyPromoted(sid, ctx.model!.id, cfg, ctx);
			return changed ? payload : undefined;
		}

		if (cfg.bootstrapMode === "zero") {
			// Subagents keep their full catalog from their very first request
			// (pi's context entries have no session_init; kept for parity with omp).
			if (!cfg.includeSubagents && isSubagentSession(entries ?? []))
				return changed ? payload : undefined;

			if (phase.boundary < 0) {
				const result = zeroAnchorPayload(payload, cfg.anchorText);
				if (!result.payload) return changed ? payload : undefined;
				if (sid) anchoredSessions.set(sid, true);
				console.log(
					`[${EXT_NAME}] anchoring first request for ${ctx.model!.provider}/${ctx.model!.id}: ` +
						"0 tools (zero-tool anchor)",
				);
				return result.payload;
			}

			// Post-compaction: no anchor, controlled tool surface.
			const zeroTools = payload.tools as ToolLike[] | undefined;
			const zeroAvailable = Array.isArray(zeroTools)
				? zeroTools
						.map((t) => toolName(t))
						.filter((n): n is string => typeof n === "string")
				: [];
			if (zeroAvailable.length > 0) {
				const selected = selectZeroBootstrapTools(
					zeroAvailable,
					cfg.compactionTools,
					phase.boundary,
				);
				if (selected.missing.length > 0) {
					console.warn(
						`[${EXT_NAME}] zero-mode bootstrap tools missing from catalog: ${selected.missing.join(", ")}; skipping filter`,
					);
					return changed ? payload : undefined;
				}
				const result = filterTools(zeroTools!, selected.tools);
				if (result.changed) {
					payload = { ...payload, tools: result.tools };
					changed = true;
					if (sid) anchoredSessions.set(sid, true);
					console.log(
						`[${EXT_NAME}] anchoring post-compaction request for ${ctx.model!.provider}/${ctx.model!.id}: ` +
							`${result.tools.length}/${zeroAvailable.length} tools (${result.tools.map(toolName).join(", ")})`,
					);
				}
			}
		} else {
			// two-tool mode
			// Subagents keep their full catalog from their very first request
			// (pi's context entries have no session_init; kept for parity with omp).
			if (!cfg.includeSubagents && isSubagentSession(entries ?? []))
				return changed ? payload : undefined;

			// Serialized tool catalog; selectBootstrapTools tries task-routing
			// first and falls back to the configured bootstrap tools.
			const tools = payload.tools as ToolLike[] | undefined;
			if (Array.isArray(tools) && tools.length > 0) {
				const available = tools
					.map((t) => toolName(t))
					.filter((n): n is string => typeof n === "string");
				const selected = selectBootstrapTools(
					cfg,
					taskMode,
					available,
					phase.boundary,
				);
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
								: "") +
							(phase.boundary >= 0 ? " [post-compaction]" : ""),
					);
				}
			}
		}

		// Strip auto-injected context (AGENTS.md, skill catalog) from the
		// first request — the omp/pi equivalent of upstream
		// `suppressedContextSources` (issue #11).
		if (cfg.suppressedContextSources.length > 0) {
			const stripped = stripContextMessages(
				payload.messages as PayloadMessage[] | undefined,
				cfg.suppressedContextSources,
			);
			if (stripped) {
				payload = { ...payload, messages: stripped };
				changed = true;
			}
		}

		return changed ? payload : undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		const cfg = loadConfig(ctx, console.warn);
		if (!isTargetModel(cfg, ctx.model) || !cfg.notify) return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !anchoredSessions.get(sid) || notified.has(sid)) return;
		notified.add(sid);
		ctx.ui.notify(
			`[${EXT_NAME}] ${ctx.model!.id}: first tool call recorded — full tool catalog restored.`,
			"info",
		);
	});
	pi.on("message_end", (event, ctx) => {
		const cfg = loadConfig(ctx, console.warn);
		if (!isTargetModel(cfg, ctx.model)) return;
		const msg = event.message as
			{ role?: string; content?: unknown } | undefined;
		if (!msg || msg.role !== "assistant") return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		trajectory.set(
			sid,
			addTrajectory(
				trajectory.get(sid) ?? { letMe: 0, we: 0, lets: 0 },
				countTrajectory(trajectoryTextFromMessage(msg)),
			),
		);
	});

	pi.on("session_compact", (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		promotionMemo.delete(sid);
	});

	pi.on("session_shutdown", () => {
		anchoredSessions.clear();
		notified.clear();
		spLogged.clear();
		promotionMemo.clear();
		trajectory.clear();
	});

	pi.registerCommand("anchored-tools", {
		description:
			"Show anchored tool bootstrap status (model targeting, current phase)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx, console.warn);
			const model = ctx.model;
			const matched = isTargetModel(cfg, model);
			const entries = ctx.sessionManager.buildContextEntries();
			const promotion = promotionPhase(entries, promoteTrigger(cfg));
			const taskMode = routeTaskMode(
				taskTextFromEntries(entries),
				model?.id ?? "",
			);
			const selected =
				cfg.bootstrapMode === "two-tool"
					? selectBootstrapTools(
							cfg,
							taskMode,
							pi.getActiveTools(),
							promotion.boundary,
						)
					: undefined;
			const status = !cfg.enabled
				? "disabled"
				: !matched
					? "not-targeted"
					: promotion.promoted
						? cfg.promotedTools.length > 0
							? "promoted (resident catalog)"
							: "promoted (full catalog)"
						: cfg.bootstrapMode === "zero"
							? promotion.boundary >= 0
								? "bootstrap (post-compaction zero-tool)"
								: "bootstrap (zero-tool anchor)"
							: `bootstrap (${selected?.tools.join(", ") ?? cfg.bootstrapTools.join(", ")} only)`;
			const sid = ctx.sessionManager.getSessionId();
			const traj = sid ? trajectory.get(sid) : undefined;
			const lines = [
				`enabled: ${cfg.enabled}`,
				`mode: ${cfg.bootstrapMode}`,
				`promote on: ${cfg.promoteOn}`,
				`target models: ${cfg.models.join(", ") || "(none — no model is anchored)"}`,
				`task routing: ${cfg.taskRouting ? `on (routerMode=${cfg.routerMode}, task=${taskMode})` : "off"}`,
				`bootstrap tools: ${selected ? `${selected.tools.join(", ")} (${selected.used})` : cfg.bootstrapTools.join(", ")}`,
				`compaction tools: ${cfg.compactionTools.join(", ") || "(none)"}`,
				`promoted tools: ${cfg.promotedTools.join(", ") || "(full catalog)"}`,
				`bootstrap max tokens: ${cfg.bootstrapMaxTokens ?? "off (default)"}`,
				`trajectory: ${traj ? `we ${traj.we}, let's ${traj.lets}, let me ${traj.letMe}` : "n/a"}`,
				`minimal system prompt: ${cfg.minimalSystemPrompt ? "on (DSH/route persona)" : "off (host default)"}`,
				`suppressed context sources: ${cfg.suppressedContextSources.join(", ") || "(disabled)"}`,
				`current model: ${model ? `${model.provider}/${model.id}` : "n/a"}`,
				`model matched: ${matched ? "yes" : "no"}`,
				`phase: ${status}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
