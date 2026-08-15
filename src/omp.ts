/**
 * anchored-tools — omp entry point.
 *
 * Port of the dsh-anchored-standard bootstrap concept to omp (Oh My Pi),
 * mirroring the pi port (dbydd/pi-anchored-tool-for-dspro) one-to-one, plus
 * the upstream zero-tool anchor mode and the `promoteOn` trigger selector.
 * The shared pure logic lives in src/core.ts.
 *
 * Mechanism note (differs from the pi entry): omp's `before_provider_request`
 * replacement is NOT honored by the openai-completions transport (the engine
 * DeepSeek and other OpenAI-compatible providers ride on — it calls onPayload
 * and discards the return). This entry therefore controls the tool surface
 * natively via `pi.setActiveTools()`: the narrowed catalog becomes the active
 * tool set before the first request is serialized, and the full captured set
 * is restored as soon as the promotion signal lands. The zero-mode anchor
 * message is injected through the `context` event, which is applied
 * pre-serialization and honored by every transport.
 *
 *   - narrow: session_start / before_agent_start → `setActiveTools(bootstrap)`
 *     or `setActiveTools([])` (zero mode) for a target-model session still in
 *     the bootstrap phase;
 *   - anchor (zero mode): `context` hook hides the real user message behind
 *     the fixed anchor turn on the first request;
 *   - restore: tool_call / message_end → `setActiveTools(full)` once the
 *     session is promoted, before the next request serializes;
 *   - the phase is derived from durable session entries via
 *     `ctx.sessionManager.getBranch()`, so /resume and /reload preserve it.
 *
 * Config lives under the top-level `anchoredTools` key of omp's settings
 * files: global `~/.omp/agent/config.yml` (or `config.yaml`) is the base, a
 * project's `<cwd>/.omp/config.yml` deep-merges over it (objects merge
 * recursively, arrays are replaced wholesale, project wins — omp's own
 * documented settings semantics).
 *
 *   # ~/.omp/agent/config.yml
 *   anchoredTools:
 *     enabled: true
 *     models:
 *       - deepseek-v4-flash        # glob patterns; "provider/modelId" or bare modelId
 *     bootstrapTools:
 *       - bash
 *       - read                    # two-tool mode only
 *     bootstrapMode: two-tool     # "two-tool" | "zero"
 *     promoteOn: either           # "tool-call" | "assistant-message" | "either"
 *     notify: true                # one-time TUI notice on promotion
 *
 * Requirements: omp runs on Bun, so `Bun.YAML.parse` is available for reading
 * YAML settings. No other runtime dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	anchorPayloadMessages,
	applyDefaults,
	deepMerge,
	extractRaw,
	isBootstrapMode,
	isPromoteOn,
	isPromoted,
	isSubagentSession,
	modelMatches,
	resolveBootstrap,
	type Config,
	type PayloadMessage,
	type RawConfig,
} from "./core";

const EXT_NAME = "anchored-tools";
const OMP_CONFIG_DIR = ".omp";
const CONFIG_FILENAMES = ["config.yml", "config.yaml"];

/** First existing config file in `dir` (config.yaml is the official compat name). */
function configCandidates(dir: string): string | undefined {
	for (const name of CONFIG_FILENAMES) {
		const path = join(dir, name);
		if (existsSync(path)) return path;
	}
	return undefined;
}

function readConfigYaml(
	logger: { warn(message: string): void },
	path: string | undefined,
): Record<string, unknown> | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch (err) {
		logger.warn(`[${EXT_NAME}] failed to parse ${path}: ${err}; ignoring`);
		return undefined;
	}
}

/** Global settings as base; project settings deep-merge over it. */
function loadConfig(
	ctx: { cwd: string },
	logger: { warn(message: string): void },
): Config {
	const globalRaw = extractRaw(
		readConfigYaml(logger, configCandidates(getAgentDir())),
	);
	const projectRaw = extractRaw(
		readConfigYaml(logger, configCandidates(join(ctx.cwd, OMP_CONFIG_DIR))),
	);
	const merged = deepMerge(globalRaw, projectRaw) as RawConfig;
	if (
		merged.bootstrapMode !== undefined &&
		!isBootstrapMode(merged.bootstrapMode)
	) {
		logger.warn(
			`[${EXT_NAME}] invalid bootstrapMode ${JSON.stringify(merged.bootstrapMode)}; using "two-tool"`,
		);
	}
	if (merged.promoteOn !== undefined && !isPromoteOn(merged.promoteOn)) {
		logger.warn(
			`[${EXT_NAME}] invalid promoteOn ${JSON.stringify(merged.promoteOn)}; using "either"`,
		);
	}
	return applyDefaults(merged);
}

export default function (pi: ExtensionAPI) {
	// Sessions currently narrowed to the bootstrap surface (active tools set).
	const narrowed = new Set<string>();
	// Sessions restored to their full active tool set after promotion.
	const restored = new Set<string>();
	// Captured full active tool set per narrowed session.
	const fullTools = new Map<string, string[]>();
	// Sessions that already showed the one-time promotion notice.
	const notified = new Set<string>();
	const logger = pi.logger;

	const isTarget = (
		model: { id: string; provider: string } | undefined,
		cfg: Config,
	): boolean =>
		!!model &&
		cfg.enabled &&
		modelMatches(model.id, model.provider, cfg.models);

	const trigger = (
		cfg: Config,
	): "tool-call" | "assistant-message" | "either" =>
		cfg.bootstrapMode === "zero" ? "assistant-message" : cfg.promoteOn;

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
		if (!sid || !cfg.notify || !narrowed.has(sid) || notified.has(sid))
			return;
		notified.add(sid);
		ctx.ui.notify(
			`[${EXT_NAME}] ${modelId}: session promoted — full tool catalog restored.`,
			"info",
		);
	};

	/**
	 * Narrow the session's active tool set before the first request is
	 * serialized. Idempotent per session; fails safe (warn + skip) when a
	 * configured bootstrap tool is missing from the catalog.
	 */
	const ensureNarrowed = async (ctx: ExtensionContext, cfg: Config) => {
		if (!cfg.enabled || cfg.models.length === 0) return;
		if (!isTarget(ctx.model, cfg)) return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || narrowed.has(sid)) return;
		const entries = ctx.sessionManager.getBranch();
		if (isPromoted(entries, trigger(cfg))) return; // already promoted
		if (cfg.bootstrapMode === "zero" && isSubagentSession(entries)) return; // subagents full catalog

		const full = pi.getActiveTools();
		let target: string[];
		if (cfg.bootstrapMode === "zero") {
			target = [];
		} else {
			const resolved = resolveBootstrap(full, cfg.bootstrapTools);
			if (resolved.missing.length > 0) {
				// Configuration error — fail safe, never strip tools silently.
				logger.warn(
					`[${EXT_NAME}] bootstrap tools missing from catalog: ${resolved.missing.join(", ")}; skipping filter`,
				);
				return;
			}
			target = resolved.tools;
		}

		narrowed.add(sid);
		fullTools.set(sid, full);
		await pi.setActiveTools(target);
		logger.info(
			`[${EXT_NAME}] anchoring first request for ${ctx.model!.provider}/${ctx.model!.id}: ` +
				(cfg.bootstrapMode === "zero"
					? "0 tools (zero-tool anchor)"
					: `${target.length}/${full.length} tools (${target.join(", ")})`),
		);
	};

	/**
	 * Restore the full active tool set once the session is promoted, before
	 * the next request serializes. Idempotent per session.
	 */
	const ensureRestored = async (ctx: ExtensionContext, cfg: Config) => {
		if (!cfg.enabled || cfg.models.length === 0) return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !narrowed.has(sid) || restored.has(sid)) return;
		if (!isTarget(ctx.model, cfg)) return;
		const entries = ctx.sessionManager.getBranch();
		if (!isPromoted(entries, trigger(cfg))) return; // not yet promoted
		const full = fullTools.get(sid);
		if (!full) return;
		restored.add(sid);
		await pi.setActiveTools(full);
		maybeNotifyPromoted(sid, ctx.model!.id, cfg, ctx);
	};

	// Narrow before the first request is serialized. session_start may run
	// before the model is known; before_agent_start always has it.
	pi.on("session_start", async (event, ctx) => {
		await ensureNarrowed(ctx, loadConfig(ctx, logger));
	});
	pi.on("before_agent_start", async (event, ctx) => {
		await ensureNarrowed(ctx, loadConfig(ctx, logger));
	});

	// Restore as soon as the promotion signal lands, before the next request.
	// tool_call covers the tool-call trigger (fires at arg-prep); message_end
	// covers the assistant-message/either trigger once the reply is durable.
	pi.on("tool_call", async (event, ctx) => {
		await ensureRestored(ctx, loadConfig(ctx, logger));
	});
	pi.on("message_end", async (event, ctx) => {
		await ensureRestored(ctx, loadConfig(ctx, logger));
	});

	// Zero-mode anchor: hide the real user message behind the fixed anchor
	// turn on the first request. The context event is applied before
	// serialization and is honored by every transport.
	pi.on("context", (event, ctx) => {
		const cfg = loadConfig(ctx, logger);
		if (
			cfg.bootstrapMode !== "zero" ||
			!cfg.enabled ||
			cfg.models.length === 0
		)
			return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid || !narrowed.has(sid) || restored.has(sid)) return;
		if (!isTarget(ctx.model, cfg)) return;
		const entries = ctx.sessionManager.getBranch();
		if (isPromoted(entries, "assistant-message")) return;
		const replaced = anchorPayloadMessages(
			event.messages as unknown as PayloadMessage[],
			cfg.anchorText,
		);
		if (replaced) return { messages: replaced as AgentMessage[] };
	});

	pi.on("session_shutdown", () => {
		narrowed.clear();
		restored.clear();
		fullTools.clear();
		notified.clear();
	});

	pi.registerCommand("anchored-tools", {
		description:
			"Show anchored tool bootstrap status (model targeting, current phase)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx, logger);
			const model = ctx.model;
			const matched = isTarget(model, cfg);
			const entries = ctx.sessionManager.getBranch();
			const promoted = isPromoted(entries, trigger(cfg));
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
