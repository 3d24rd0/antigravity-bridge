// Runtime config for the antigravity provider. Persisted at
// <agentDir>/antigravity-bridge/config.json so the /agy command can
// toggle settings that take effect on the next turn.
//
// Knobs today:
//   mode            "accept-edits" (default) or "plan". Drives agy's --mode.
//   skipPermissions true (default). Passes --dangerously-skip-permissions so
//                   commands don't hang on an unanswerable prompt in -p mode.
//
// Env overrides (AGY_MODE, AGY_SKIP_PERMISSIONS) win over the file so tests
// and one-off runs can force a setting without editing the file.

import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeAgyAgentName } from "./agents.js";

/** pi's agent dir (env override PI_CODING_AGENT_DIR, else ~/.pi/agent); every
 *  bridge-owned path derives from it AT CALL TIME so isolated or rebranded pi
 *  homes keep their state together (upstream 8dee43b / #17). */
export function bridgeDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "antigravity-bridge");
}

/** Back-compat alias kept so out-of-surface consumers (src/acp/update.ts)
 *  compile unchanged and inherit the agent-dir resolution. Prefer bridgeDir(). */
export function bridgeDataDir(): string {
	return bridgeDir();
}

export function configPath(agentDir: string = getAgentDir()): string {
	return path.join(bridgeDir(agentDir), "config.json");
}

/** Injection seam for loadConfig/saveConfig defaults (pre-8dee43b shape). */
export function defaultConfigPath(): string {
	return configPath();
}

/** Daily debug logs land here, sorted by day, for post-mortems and user
 *  support (see src/daily-log.ts). Fork shape: stays under the bridge data
 *  dir; upstream 8dee43b moved logs to extensions-data, but relocating this
 *  fork's logs would strand existing user data, so only the root relocates. */
export function logsDir(agentDir: string = getAgentDir()): string {
	return path.join(bridgeDir(agentDir), "logs");
}

/** Which turn engine drives turns. "acp" (the official server) is the
 *  default for new installs; "stream-json" (the `agy` CLI) remains a fully
 *  supported fallback. */
export type Engine = "stream-json" | "acp";

/** The engine a fresh install runs when nothing is configured (no file key,
 *  no AGY_ENGINE): the official ACP server. Unknown/stale stored values also
 *  fall back here; the first startup's acp self-heal installs the binary and
 *  chains the sign-in. */
export const DEFAULT_ENGINE: Engine = "acp";
export type AgyMode = "accept-edits" | "plan";
/** Kept structurally identical to models.ts AgyEffort (declared locally, not
 *  imported, so config.ts <-> models.ts never form an import cycle now that
 *  models.ts imports bridgeDir() from here). */
export type ThinkingTier = "low" | "medium" | "high" | "xhigh";
export type BridgeTools = "none" | "mcp" | "all";

/** How ACP turns report token usage while Gate B stands (agy sends none).
 *  "estimate" (default): word-boundary regex over prompt/response/thought
 *  text (pi-token-speed's mechanism). "direct": 1 token per streamed delta.
 *  "off": keep zero-usage. Real server usage (usageSeen latch) always wins. */
export type UsageEstimate = "estimate" | "direct" | "off";

/** How the approval gate activates.
 *
 *  "auto" (default): OFF until a third-party pi permission extension is
 *  detected (src/approval-detect.ts). When one is found, the gate runs in
 *  "shadow" mode so that extension gates agy's native tool calls with zero
 *  configuration on its side.
 *
 *  "shadow" / "dedicated": force the gate on in that shape. "off": never
 *  gate, even when a permission extension is installed. NOTE: "dedicated"
 *  currently stages the same shadow tools as "shadow" (warn-logged remap);
 *  the explicit antigravity_approve variant is planned. */
export type GateMode = "auto" | "shadow" | "dedicated" | "off";

/** Fallback decision when no extension blocked a gated call: "ask" uses
 *  ctx.ui.confirm (headless = deny, fail-closed), "allow" auto-approves,
 *  "deny" auto-rejects. */
export type GateAskMode = "ask" | "allow" | "deny";

export interface GateConfig {
	gateMode: GateMode;
	mode: GateAskMode;
}

export interface AcpConfig {
	/** Path to agy_acp_server.par. Empty = env AGY_ACP_BIN > PATH. */
	bin: string;
	/** Gate B stopgap: client-side token estimates for ACP turns so pi's
	 *  usage surfaces show nonzero numbers. Estimates are labeled as such in
	 *  /agy doctor and auto-disable when the server sends real usage. */
	usageEstimate: UsageEstimate;
}

export interface AgyConfig {
	/** Engine. Switching requires a pi restart (drivers wire at load). */
	engine: Engine;
	/** Official-server ACP engine options (used when engine = "acp"). */
	acp: AcpConfig;
	mode: AgyMode;
	/** Fail-closed kill switch for provider turns. ON = every provider turn
	 *  is refused visibly: the agy CLI has no review-only enforcement on any
	 *  path (probed 2026-10-07, upstream #1181: plan mode stages a plan and
	 *  executes the write in the same turn on -p and stream-json alike; the
	 *  ACP engine has no plan mode at all). Built for callers like
	 *  `pi -p --no-tools` health checks that must never mutate a workspace
	 *  and prefer a visible refusal over a write-capable turn. Wins over
	 *  `mode`; the AskAntigravity delegation tool is refused while this is on
	 *  (the CLI has no review-only enforcement, so nothing here can run
	 *  read-only). Env AGY_READONLY wins over the file.
	 *  Default false. */
	readOnly: boolean;
	/** Auto-approve all agy tool permission requests (--dangerously-skip-permissions).
	 *  Required for non-interactive use: without it, any `run_command` triggers an
	 *  interactive y/n prompt that hangs forever in `-p` mode. Defaults true.
	 *  DANGEROUS: lets agy run arbitrary commands (including destructive ones)
	 *  without review. The ask tool withholds the flag on plan runs;
	 *  accept-edits runs need it to avoid hanging on the unanswerable prompt. */
	skipPermissions: boolean;
	/** AskAntigravity tool: default model alias (flash/argon/gemini/sonnet/opus or exact). */
	defaultModel: string;
	/** AskAntigravity tool: default thinking tier when the alias names none. */
	defaultThinking: ThinkingTier;
	/** Register the AskAntigravity one-shot delegation tool. Default on.
	 *  off removes the tool entirely for users who want only the provider
	 *  and models (no delegation tool in the model's window context).
	 *  Takes effect at pi start (or /reload). */
	askTool: boolean;
	/** Register the agy_web_search + agy_read_url Pi tools. Default OFF:
	 *  inside Antigravity sessions the model already has native web tools;
	 *  these exist for NON-Antigravity provider sessions and every call
	 *  spends Antigravity quota. Takes effect at pi start (or /reload). */
	webTools: boolean;
	/** Set after the one-time notice about a leftover legacy invokeTool patch
	 *  on the installed pi. The notice never repeats; /agy patch-cleanup is
	 *  always available. */
	patchCleanupNotified?: boolean;
	/** Custom agy agent for stream-json turns (`--agent`, /agy agent).
	 *  Absent = agy's default agent. ACP turns ignore it (no protocol slot). */
	agent?: string;
	/** Which pi tools the MCP bridge exposes to agy: "none" (bridge off),
	 *  "all" (every registered non-builtin tool incl. other Ask* delegations;
	 *  default - users expect the bridge working out of the box, and the
	 *  "mcp" surface serves an empty catalog on installs without
	 *  pi-mcp-adapter), "mcp" (pi-mcp-adapter tools + skills bridge only). */
	bridgeTools: BridgeTools;
	/** Extra pi tool names that get the long (120s) synchronous escalation
	 *  window, in addition to delegation-shaped names (subagent_run,
	 *  agent_spawn/agent_wait, *delegate*; issue #6). For custom tools that
	 *  legitimately run minutes-long but must return a plain result to an
	 *  orchestrator. Env AGY_ESCALATE_LONG_TOOLS (comma-separated) wins over
	 *  the file. Takes effect on the next bridge call. */
	escalateLongTools?: string[];
	/** Inject a delta digest of pi-side context (compaction summaries, turns
	 *  handled by other providers or pi's own tools) into each agy prompt.
	 *
	 *  Default ON, and self-gating: a digest ships only when the delta window
	 *  is non-empty, and each piece ships once - the same compaction summary is
	 *  never re-injected and a pure antigravity session has an empty delta, so
	 *  its prompts stay byte-identical and agy's server-side prompt cache keeps
	 *  hitting. Fresh conversations (model switch, engine switch, recreation)
	 *  get the pi-side handoff they would otherwise miss. On stream-json the
	 *  digest is budgeted in UTF-8 bytes under the CLI's ~25KB silent-drop cap
	 *  (an over-cap digest is skipped, never sent).
	 *
	 *  Turn off for prompt-only behavior: agy then receives only your message
	 *  (plus the one-time system prompt), and pi-side context never crosses over.
	 *  Env AGY_DIGEST wins over the file. */
	digest: boolean;
	/** Prepend pi's composed system prompt (pi tool guidance + the global
	 *  agent-dir AGENTS.md and ancestor AGENTS.md/CLAUDE.md) to the FIRST
	 *  prompt of each fresh agy conversation.
	 *
	 *  Default ON: agy keeps its own history, so the prefix is sent once per
	 *  conversation and stays byte-identical afterwards - agy's server-side
	 *  prompt cache keeps hitting. This is why it is safe here while the G1
	 *  digest (per-turn) is not. Turn off for agy-native behavior (agy's own
	 *  system prompt only). */
	systemPrompt: boolean;
	/** Overall cap on ONE agy turn in minutes, both engines. When it fires, the
	 *  bridge kills the agy process mid-task ("ACP turn exceeded the Xm
	 *  deadline" / "agy exceeded the Xm turn timeout"). The ACP server binary
	 *  exposes no timeout flag of its own (--helpfull: debug/notices only), so
	 *  this bridge cap is the only knob.
	 *
	 *  Default is TTY-aware: 0 (no cap) on an interactive pi - the user aborts
	 *  with Esc and is the better backstop - and 20 on headless runs, where
	 *  nobody can abort and one runaway turn blocks the drivers' serialized
	 *  turn queue. Explicit values opt into the gate: 1..1440 valid, 0
	 *  disables, anything else (garbage, negative, >1440) falls back to the
	 *  TTY-aware default. The inactivity stall guard (5m silence) still bounds
	 *  a hung server either way. Next-turn effect. Env AGY_TURN_TIMEOUT_MIN
	 *  wins over the file. */
	turnTimeoutMin: number;
	/** Silence cap in minutes, both engines: no stream-json stdout / no ACP
	 *  session/update for this long fails the turn as a stall. Default 5;
	 *  0 disables the guard. Next-turn effect.
	 *  Env AGY_INACTIVITY_TIMEOUT_MIN wins over the file. */
	inactivityTimeoutMin: number;
	/** Approval gate over agy NATIVE tool calls (create_file, run_command,
	 *  ...). pi tools agy calls already pass through pi's gates via the G9
	 *  round-trip; this covers the rest. Default auto (off until a
	 *  third-party permission extension is detected). */
	approvals: GateConfig;
	/** In-memory only: parse fallbacks collected by loadConfig for hand-edited
	 *  config.json boolean/enum fields that could not be honored (issue #23).
	 *  Surfaced at startup via notifyConfigWarnings (entry.ts); never persisted
	 *  by saveConfig, and always undefined for a pristine file. */
	parseWarnings?: readonly string[];
}

const DEFAULTS: AgyConfig = {
	engine: DEFAULT_ENGINE,
	mode: "accept-edits",
	readOnly: false,
	skipPermissions: true,
	defaultModel: "flash",
	defaultThinking: "low",
	askTool: true,
	webTools: false,
	bridgeTools: "all",
	digest: true,
	systemPrompt: true,
	turnTimeoutMin: 0, // placeholder: the real default is resolved per loadConfig call (defaultTurnTimeoutMin)
	inactivityTimeoutMin: 5,
	approvals: { gateMode: "auto", mode: "ask" },
	acp: { bin: "", usageEstimate: "estimate" },
};

/** Hard ceiling for a free-typed turn cap: one day, in minutes. */
export const MAX_TURN_CAP_MIN = 1440;

/** TTY-aware default for the overall turn cap. An interactive user aborts
 *  with Esc and is the better backstop; the wall clock only earns its keep
 *  where nobody can abort (headless runs: one runaway turn also blocks the
 *  drivers' serialized turn queue). */
export function defaultTurnTimeoutMin(): number {
	return process.stdout.isTTY || process.stdin.isTTY ? 0 : 20;
}

/** Explicit cap minutes: 0 keeps (disable), 1..MAX_TURN_CAP_MIN keeps;
 *  garbage, negative, or out-of-range falls back to the caller's default.
 *  Pass Number.NaN as the fallback to detect rejection via isNaN. */
export function parseCapMinutes(raw: string | number | undefined, fallback: number): number {
	if (raw === undefined || String(raw).trim() === "") return fallback;
	const n = typeof raw === "number" ? raw : Number(String(raw).trim());
	if (!Number.isFinite(n)) return fallback;
	if (n === 0) return 0;
	return n >= 1 && n <= MAX_TURN_CAP_MIN ? n : fallback;
}

/** Boolish vocabulary for file-config booleans (issue #23): the /agy
 *  on|off vocabulary plus 0/1 numbers, case/whitespace tolerated. Junk
 *  falls back to the per-key default and warns instead of being a truthy
 *  string that silently enables ("digest": "false" used to ENABLE digest).
 *  null/undefined are absent-like: default silently, no warning. */
const BOOLISH_TRUE = new Set(["1", "true", "on"]);
const BOOLISH_FALSE = new Set(["0", "false", "off"]);

export function parseBoolish(raw: unknown): boolean | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "number") {
		if (raw === 0) return false;
		if (raw === 1) return true;
		return undefined; // junk number: caller warns
	}
	if (typeof raw === "string") {
		const s = raw.trim().toLowerCase();
		if (BOOLISH_TRUE.has(s)) return true;
		if (BOOLISH_FALSE.has(s)) return false;
		return undefined; // junk string: caller warns
	}
	return undefined; // array/object: caller warns
}

/** Whether a file-config key is absent-like: undefined OR null both mean the
 *  user did not set it (JSON null ~ absent), so loadConfig falls back to the
 *  default silently without a parse warning. */
function keyIsAbsent(raw: unknown): boolean {
	return raw === undefined || raw === null;
}

/** Fail-closed variant for the readOnly safety knob: empty string means the
 *  user explicitly blanked it (off), ANY other set value that is not a
 *  spelled-out falsity counts as ON, mirroring the AGY_READONLY env grammar.
 *  Boolish-set values resolve through the vocabulary; junk warns separately
 *  and fails closed. */
export function parseReadOnlyValue(raw: unknown): boolean | "junk" | undefined {
	// env grammar mirrored: empty string = off; every OTHER present value that
	// is not a spelled-out falsity is ON fail-closed, INCLUDING true/1 - the
	// intent of a boolish true on a safety knob is on, and junk (unrecognized
	// strings, non-bool non-0/1 shapes) warns via parseWarnings and fails
	// closed. undefined/null = absent (caller default).
	if (raw === "") return false;
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") {
		const s = raw.trim().toLowerCase();
		if (s === "0" || s === "false" || s === "off") return false;
		return true; // any other non-blank string: ON (no warning; env grammar)
	}
	return "junk"; // numbers (1/0 are env-grammar ON/OFF; file path: call sites pass raw JSON numbers -> treat as junk+warn per the fork's fail-closed test) and other shapes
}

/** Whether a config.json key is overridden by an env var, so loadConfig
 *  never parses (nor warns about) a file value the env would discard. */
function envOverrides(key: keyof AgyConfig): boolean {
	const envs: Partial<Record<keyof AgyConfig, string | undefined>> = {
		skipPermissions: process.env.AGY_SKIP_PERMISSIONS,
		readOnly: process.env.AGY_READONLY,
		askTool: process.env.AGY_ASK_TOOL,
		webTools: process.env.AGY_WEB_TOOLS,
		digest: process.env.AGY_DIGEST,
		systemPrompt: process.env.AGY_SYSTEM_PROMPT,
	};
	return envs[key] !== undefined;
}

/** Compose the startup warning message for a hand-edited config.json whose
 *  boolean/enum fields could not be parsed (issue #23). Shared by
 *  notifyConfigWarnings and tests. Line format is emitted per parsed key by
 *  the parse sites; this wrapper names the problem and the /agy doctor
 *  escape hatch. */
export function configWarningsMessage(warnings: readonly string[]): string {
	const n = warnings.length;
	const head = n === 1 ? "1 unparseable value" : `${n} unparseable values`;
	return `config warnings: ${head} in config.json (defaults used; run /agy doctor for details): ${warnings.join(", ")}`;
}

/** Read the raw config file (no defaults, no env). Shared by loadConfig and
 *  saveConfig so persisted writes can never bake env overrides into the file. */
function readConfigFile(configPath: string): Partial<AgyConfig> {
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Partial<AgyConfig>;
		}
	} catch {
		/* missing or corrupt  -  fall back to empty */
	}
	return {};
}

/** Load config merged over defaults. Env vars override the file when set.
 *  File booleans parse through the boolish vocabulary (issue #23); junk
 *  values fall back to the safe default and collect a parse warning that
 *  surfaces at startup (notifyConfigWarnings) instead of silently changing
 *  behavior - the truthy-string bug class: "digest": "false" used to
 *  ENABLE digest. */
export function loadConfig(configPath: string = defaultConfigPath()): AgyConfig {
	const seenWarnings = new Set<string>();
	const parseWarnings: string[] = [];
	const warnParse = (key: string): void => {
		if (seenWarnings.has(key)) return;
		seenWarnings.add(key);
		parseWarnings.push(key);
	};
	let file: Partial<AgyConfig> = readConfigFile(configPath);

	// Env overrides file (matches the skipPermissions pattern).
	// The naive OR `env === "plan" || file.mode === "plan"` would ignore an
	// explicit AGY_MODE=accept-edits when the file says plan, violating the
	// documented precedence. Check env first.
	// Engine: narrow to the known set; anything else (incl. the pre-1.3.2
	// "sqlite" value) falls back to the default engine, same as an absent key.
	// One absence exception: a config file WITHOUT an engine key belongs to an
	// existing install (saveConfig persists the resolved legacy engine), and
	// the acp default is for new installs only - an existing install keeps
	// the legacy stream-json engine instead of silently starting the ~1.5 GB
	// acp download. existsSync is false on EACCES too, which reads as fresh
	// and picks acp; an unreadable config dir is a broken install either way.
	const freshInstall = !fs.existsSync(configPath);
	const engineFallback = freshInstall || file.engine !== undefined ? DEFAULT_ENGINE : "stream-json";
	const engine = narrowEngine(String(process.env.AGY_ENGINE ?? file.engine ?? engineFallback).toLowerCase());
	// Non-string engine (hand-edit 7): narrow via String in the same call.
	if (file.engine !== undefined && typeof file.engine !== "string" && !envOverrides("engine")) warnParse("engine");
	if (typeof file.agent !== "undefined" && typeof file.agent !== "string") warnParse("agent");
	if (file.approvals !== undefined && typeof file.approvals === "object" && file.approvals !== null) {
		for (const [k, v] of Object.entries(file.approvals as unknown as Record<string, unknown>)) {
			if (v !== undefined && typeof v !== "string") parseWarnings.push(`approvals.${k}`);
		}
	}

	if (file.mode !== undefined && typeof file.mode !== "string") warnParse("mode");
	const mode: AgyMode =
		process.env.AGY_MODE !== undefined
			? process.env.AGY_MODE === "plan"
				? "plan"
				: "accept-edits"
			: file.mode === "plan"
				? "plan"
				: "accept-edits";

	const envPerm = process.env.AGY_SKIP_PERMISSIONS;
	const skipPermissions = envPerm !== undefined
		? envPerm === "1" || envPerm.toLowerCase() === "true"
		: (() => {
			if (envOverrides("skipPermissions")) return DEFAULTS.skipPermissions;
			const b = parseBoolish(file.skipPermissions);
			if (b === undefined && !keyIsAbsent(file.skipPermissions)) warnParse("skipPermissions");
			return b ?? DEFAULTS.skipPermissions;
		})();

	const envReadOnly = process.env.AGY_READONLY;
	// Fail-closed parse for a safety knob: empty string means the user
	// explicitly blanked it (off), but ANY other set value that is not a
	// spelled-out falsity counts as ON. " 1", "yes", typos: all refuse.
	// The FILE path parses through the fail-closed variant: boolish vocabulary
	// resolves; junk fails closed and warns (issue #23) instead of trusting.
	const readOnly = envReadOnly !== undefined
		? envReadOnly === ""
			? false
			: !["0", "false", "off"].includes(envReadOnly.trim().toLowerCase())
		: (() => {
			if (envOverrides("readOnly")) return DEFAULTS.readOnly;
			const parsed = parseReadOnlyValue(file.readOnly);
			if (parsed === "junk" && !keyIsAbsent(file.readOnly)) {
				warnParse("readOnly");
				return true as const; // fail closed
			}
			return (parsed ?? DEFAULTS.readOnly) as boolean;
		})();

	const defaultModelRaw =
		process.env.AGY_DEFAULT_MODEL ?? file.defaultModel ?? DEFAULTS.defaultModel;
	const defaultModel: string =
		typeof defaultModelRaw === "string"
			? defaultModelRaw.trim() || DEFAULTS.defaultModel
			: (warnParse("defaultModel"), DEFAULTS.defaultModel as string);

	const envThink = process.env.AGY_DEFAULT_THINKING;
	const thinkSrc: unknown = envThink ?? file.defaultThinking ?? DEFAULTS.defaultThinking;
	if (typeof thinkSrc !== "string") warnParse("defaultThinking");
	const thinkRaw = String(thinkSrc).toLowerCase();
	// agy's own tier vocabulary, inlined (same values as models.ts
	// AGY_EFFORT_ORDER) to keep config.ts models-import-free. A tier agy has no
	// equivalent for (pi's max, a typo) falls back to the balanced default.
	const defaultThinking: ThinkingTier = (["low", "medium", "high", "xhigh"] as readonly string[]).includes(thinkRaw)
		? (thinkRaw as ThinkingTier)
		: "medium";

	const askTool = process.env.AGY_ASK_TOOL !== undefined
		? ["1", "true", "on"].includes(process.env.AGY_ASK_TOOL.toLowerCase())
		: envOverrides("askTool") ? (undefined as unknown as boolean)
		: (() => {
			if (envOverrides("askTool")) return DEFAULTS.askTool;
			const b = parseBoolish(file.askTool);
			if (b === undefined && !keyIsAbsent(file.askTool)) warnParse("askTool");
			return b ?? DEFAULTS.askTool;
		})();

	const webTools = process.env.AGY_WEB_TOOLS !== undefined
		? ["1", "true", "on"].includes(process.env.AGY_WEB_TOOLS.toLowerCase())
		: (() => {
			if (envOverrides("webTools")) return DEFAULTS.webTools;
			const b = parseBoolish(file.webTools);
			if (b === undefined && !keyIsAbsent(file.webTools)) warnParse("webTools");
			return b ?? DEFAULTS.webTools;
		})();

	const bridgeSrc: unknown = process.env.AGY_BRIDGE_TOOLS ?? file.bridgeTools ?? DEFAULTS.bridgeTools;
	if (typeof bridgeSrc !== "string" && !envOverrides("bridgeTools")) warnParse("bridgeTools");
	const bridgeRaw = String(bridgeSrc).toLowerCase();
	const bridgeTools: BridgeTools =
		bridgeRaw === "none" || bridgeRaw === "all" || bridgeRaw === "mcp"
			? bridgeRaw
			: DEFAULTS.bridgeTools;

	// Extra long-window tool names for the bridge escalation (issue #6).
	// Comma-separated in the env; junk entries and junk shapes are dropped,
	// not fatal - loadConfig runs per bridge call and must never throw.
	const longToolsRaw: unknown =
		process.env.AGY_ESCALATE_LONG_TOOLS ?? file.escalateLongTools;
	const longToolsParts: unknown[] = typeof longToolsRaw === "string"
		? longToolsRaw.split(",")
		: Array.isArray(longToolsRaw) ? longToolsRaw : [];
	const escalateLongTools = longToolsParts
		.filter((s): s is string => typeof s === "string")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.slice(0, 32);

	const digest = process.env.AGY_DIGEST !== undefined
		? ["1", "true", "on"].includes(process.env.AGY_DIGEST.toLowerCase())
		: (() => {
			if (envOverrides("digest")) return DEFAULTS.digest;
			const b = parseBoolish(file.digest);
			if (b === undefined && !keyIsAbsent(file.digest)) warnParse("digest");
			return b ?? DEFAULTS.digest;
		})();

	const envSys = process.env.AGY_SYSTEM_PROMPT;
	const systemPrompt = envSys !== undefined
		? ["1", "true", "on"].includes(envSys.toLowerCase())
		: (() => {
			if (envOverrides("systemPrompt")) return DEFAULTS.systemPrompt;
			const b = parseBoolish(file.systemPrompt);
			if (b === undefined && !keyIsAbsent(file.systemPrompt)) warnParse("systemPrompt");
			return b ?? DEFAULTS.systemPrompt;
		})();

	// Turn caps, minutes. Env wins over the file (same pattern as mode).
	const turnTimeoutMin = parseCapMinutes(
		process.env.AGY_TURN_TIMEOUT_MIN ?? file.turnTimeoutMin,
		defaultTurnTimeoutMin(),
	);
	const inactivityTimeoutMin = parseCapMinutes(
		process.env.AGY_INACTIVITY_TIMEOUT_MIN ?? file.inactivityTimeoutMin,
		DEFAULTS.inactivityTimeoutMin,
	);

	// Approval gate. Unknown values fall back to "auto"
	// so a typo can never silently force the gate on.
	const gateSrc: unknown = process.env.AGY_APPROVALS ?? file.approvals?.gateMode ?? DEFAULTS.approvals.gateMode;
	if (typeof gateSrc !== "string") warnParse("approvals.gateMode");
	const gateRaw = String(gateSrc).toLowerCase();
	const gateMode: GateMode =
		gateRaw === "shadow" || gateRaw === "dedicated" || gateRaw === "off"
			? gateRaw
			: "auto";
	const askSrc: unknown = process.env.AGY_APPROVALS_MODE ?? file.approvals?.mode ?? DEFAULTS.approvals.mode;
	if (typeof askSrc !== "string") warnParse("approvals.mode");
	const askRaw = String(askSrc).toLowerCase();
	const gateAskMode: GateAskMode =
		askRaw === "allow" || askRaw === "deny"
			? askRaw
			: "ask";

	const fileAcp = (typeof file.acp === "object" && file.acp !== null ? file.acp : {}) as Partial<AcpConfig>;
	// Unknown values fall back to "estimate" (same narrow-parse pattern as
	// gateMode: a typo must never silently change behavior).
	const usageRaw = String(
		process.env.AGY_USAGE_ESTIMATE ?? fileAcp.usageEstimate ?? DEFAULTS.acp.usageEstimate,
	).toLowerCase();
	const usageEstimate: UsageEstimate =
		usageRaw === "direct" || usageRaw === "off" ? usageRaw : "estimate";
	const acp: AcpConfig = {
		bin:
			process.env.AGY_ACP_BIN ??
			(typeof fileAcp.bin === "string" ? fileAcp.bin : DEFAULTS.acp.bin),
		usageEstimate,
	};

	// Custom agent for stream-json turns (--agent). Env wins over the file
	// (same pattern as mode). Normalized (trim/cap/control-strip); an empty
	// result means agy's default agent. Non-string junk warns and drops
	// (issue #23 review hardening).
	const agentRaw: unknown = process.env.AGY_AGENT ?? file.agent;
	if (typeof agentRaw !== "undefined" && typeof agentRaw !== "string") warnParse("agent");
	const agent = typeof agentRaw === "string" ? normalizeAgyAgentName(agentRaw) : undefined;

	return {
		engine,
		acp,
		mode,
		readOnly,
		skipPermissions,
		defaultModel,
		defaultThinking,
		askTool,
		webTools,
		bridgeTools,
		escalateLongTools,
		digest,
		systemPrompt,
		turnTimeoutMin,
		inactivityTimeoutMin,
		agent,
		approvals: { gateMode, mode: gateAskMode },
		patchCleanupNotified: file.patchCleanupNotified === true,
		...(parseWarnings.length ? { parseWarnings: Object.freeze(parseWarnings) } : {}),
	};
}

/** Narrow a raw engine string to the known set; anything unknown (incl. the
 *  pre-1.3.2 "sqlite" value) falls to the default engine. Shared by
 *  loadConfig's effective-engine resolution and saveConfig's persistence so
 *  the two can never drift. */
function narrowEngine(raw: string): Engine {
	return raw === "acp" || raw === "stream-json" ? raw : DEFAULT_ENGINE;
}

/** Atomically persist a config patch (temp + rename). Merges onto the RAW
 *  FILE values, never loadConfig(): env overrides must not be baked into the
 *  file (AGY_READONLY=1 in the env would otherwise persist readOnly: true to
 *  disk on any unrelated save, outliving the env var). Nested objects are
 *  re-normalized to their known keys: a raw passthrough would resurrect
 *  legacy keys (acp.permissions) that loadConfig normalization drops. */
export function saveConfig(patch: Partial<AgyConfig>, configPath: string = defaultConfigPath()): AgyConfig {
	const file = readConfigFile(configPath);
	// Null-safe on nested objects: a hand-edited or legacy file can carry
	// "acp": null; loadConfig tolerates it, so must saveConfig. Key presence
	// triggers normalization (a null becomes the default shape, never null).
	const fileAcp: Partial<AcpConfig> = file.acp && typeof file.acp === "object" ? file.acp : {};
	const fileApprovals: Partial<GateConfig> = file.approvals && typeof file.approvals === "object" ? file.approvals : {};
	// Engine persistence follows loadConfig's continuity rule minus env (env
	// must never be baked into the file). A legacy file without an engine key
	// persists "stream-json": the bare DEFAULTS spread below would otherwise
	// write the acp default into an existing install's file on any unrelated
	// save, arming the ~1.5 GB download on the next start.
	const persistedEngine = patch.engine ?? file.engine
		?? (fs.existsSync(configPath) ? "stream-json" : DEFAULT_ENGINE);
	const next: AgyConfig = {
		...DEFAULTS,
		...file,
		...(file.acp !== undefined
			? { acp: { bin: fileAcp.bin ?? DEFAULTS.acp.bin, usageEstimate: fileAcp.usageEstimate ?? DEFAULTS.acp.usageEstimate } }
			: {}),
		...(file.approvals !== undefined
			? { approvals: { gateMode: fileApprovals.gateMode ?? DEFAULTS.approvals.gateMode, mode: fileApprovals.mode ?? DEFAULTS.approvals.mode } }
			: {}),
		...patch,
		engine: narrowEngine(String(persistedEngine).toLowerCase()),
	};
	// parseWarnings is loadConfig's in-memory field: never persisted (a hand
	// editor's junk value stays exactly as written on disk). A raw file that
	// carried a stale parseWarnings key must not round-trip either.
	const persisted = next as Partial<AgyConfig> & { parseWarnings?: readonly string[] };
	delete persisted.parseWarnings;
	const dir = path.dirname(configPath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${configPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, configPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing to clean */
		}
		throw err;
	}
	return next;
}
