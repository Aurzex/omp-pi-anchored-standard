/**
 * anchored-tools — pi entry point.
 *
 * Direct adaptation of dbydd/pi-anchored-tool-for-dspro's index.ts, with the
 * config defaults/merge helpers hoisted into src/core.ts for sharing with the
 * omp entry (src/omp.ts), plus the upstream zero-tool anchor mode and the
 * `promoteOn` trigger selector.
 *
 * DeepSeek V4 Pro conditions strongly on the API-visible tool catalog: the
 * official Standard/PTC presets scored 91/92 on Project2 while Minimal scored
 * 99/96 — but Minimal only exposes two tools. This extension replicates the
 * two-phase "anchored standard" preset
 * (https://github.com/xiaobright/dsh-anchored-standard):
 *
 *   1. For a configured target model, the FIRST provider request exposes only
 *      the bootstrap catalog (default: `bash` + `read`), or zero tools with a
 *      fixed anchor turn in `bootstrapMode: "zero"`.
 *   2. After the session's first durable promotion signal (per `promoteOn`),
 *      every later request exposes the full catalog.
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
 *       "anchorText": "This round is a test. Tools are not open yet; all tools will open next round.",
 *       "notify": true                       // one-time TUI notice on promotion
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
	deepMerge,
	extractRaw,
	filterTools,
	isBootstrapMode,
	isPromoteOn,
	isPromoted,
	isSubagentSession,
	modelMatches,
	toolName,
	zeroAnchorPayload,
	type Config,
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
	return applyDefaults(merged);
}

export default function (pi: ExtensionAPI) {
	// Per-session: was the first request actually anchored (catalog filtered)?
	const anchoredSessions = new Map<string, boolean>();
	const notified = new Set<string>();

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

		const entries = ctx.sessionManager.buildContextEntries();
		const sid = ctx.sessionManager.getSessionId();

		if (cfg.bootstrapMode === "zero") {
			// Subagents keep their full catalog from their very first request.
			if (isSubagentSession(entries)) return;
			// The anchor reply promotes the session (assistant-message trigger).
			if (isPromoted(entries, "assistant-message")) {
				if (sid) maybeNotifyPromoted(sid, ctx.model!.id, cfg, ctx);
				return;
			}
			const payload = event.payload as
				Record<string, unknown> | undefined;
			const result = zeroAnchorPayload(payload, cfg.anchorText);
			if (!result.payload) return;
			if (sid) anchoredSessions.set(sid, true);
			console.log(
				`[${EXT_NAME}] anchoring first request for ${ctx.model!.provider}/${ctx.model!.id}: ` +
					"0 tools (zero-tool anchor)",
			);
			return result.payload;
		}

		// two-tool mode
		if (isPromoted(entries, cfg.promoteOn)) {
			if (sid) maybeNotifyPromoted(sid, ctx.model!.id, cfg, ctx);
			return; // already promoted
		}

		const payload = event.payload as { tools?: ToolLike[] };
		if (!Array.isArray(payload?.tools) || payload.tools.length === 0)
			return;

		const result = filterTools(payload.tools, cfg.bootstrapTools);
		if (result.missing.length > 0) {
			// Configuration error — fail safe, never strip tools silently.
			console.warn(
				`[${EXT_NAME}] bootstrap tools missing from catalog: ${result.missing.join(", ")}; skipping filter`,
			);
			return;
		}
		if (!result.changed) return; // catalog already minimal

		if (sid) anchoredSessions.set(sid, true);
		console.log(
			`[${EXT_NAME}] anchoring first request for ${ctx.model!.provider}/${ctx.model!.id}: ` +
				`${result.tools.length}/${payload.tools.length} tools (${result.tools.map(toolName).join(", ")})`,
		);
		return { ...payload, tools: result.tools };
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
			const phase = !cfg.enabled
				? "disabled"
				: !matched
					? "not-targeted"
					: promoted
						? "promoted (full catalog)"
						: cfg.bootstrapMode === "zero"
							? "bootstrap (zero-tool anchor)"
							: "bootstrap (shell + read only)";
			const lines = [
				`enabled: ${cfg.enabled}`,
				`mode: ${cfg.bootstrapMode}`,
				`promote on: ${cfg.promoteOn}`,
				`target models: ${cfg.models.join(", ") || "(none — no model is anchored)"}`,
				`bootstrap tools: ${cfg.bootstrapTools.join(", ")}`,
				`current model: ${model ? `${model.provider}/${model.id}` : "n/a"}`,
				`model matched: ${matched ? "yes" : "no"}`,
				`phase: ${phase}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
