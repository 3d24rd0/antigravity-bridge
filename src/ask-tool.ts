// The AskAntigravity tool: delegate a self-contained sub-task to Google
// Antigravity's `agy` CLI. Ported from pi-ask-antigravity v1.1.0 so this
// extension (pi-antigravity-bridge) provides BOTH the streaming provider AND
// the one-shot delegation tool - the same shape as pi-claude-bridge.
//
// One self-contained tool. Spawns `agy -p`, streams its stdout as partial
// output, returns the final response. agy runs its OWN tool loop (read,
// write, edit, exec) inside the workspace.
//
// When both pi-antigravity-bridge and pi-ask-antigravity are installed, the
// bridge wins: pi-ask-antigravity detects the bridge package and registers
// nothing (see its defer guard). This module is the single source of truth.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { contentText, type ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	buildAgyArgs,
	buildFinalPrompt,
	buildTimeBudgetNotice,
	MAX_TIMEOUT_MINUTES,
	CONVERSATIONS_DIR,
	CONV_ID_RE,
	filterHiddenModels,
	mergeCatalog,
	newConversationId,
	parseModelLine,
	resolveAgyModel,
	snapshotConversations,
	type ModelEntry,
	type Mode,
} from "./agy-peer.js";
import { loadConfig, type AgyMode, type ThinkingTier } from "./config.js";
import { redactText } from "./redact.js";
import { acquireBridgeSuppression } from "./mcp-registration.js";
import { AGY_EFFORT_ORDER, spawnAgyModelsRaw, toAgyEffort } from "./models.js";
import { sweepStaleWebAgents, webAgentsRoot } from "./web-tools.js";
import {
	beginBackgroundRun,
	disposeBackgroundRuns,
	endBackgroundRun,
	lockConversation,
	markBackgroundFinishing,
	registerBackgroundKill,
	resetBackgroundState,
	sendBackgroundWake,
	settleBackgroundRun,
	summarizePrompt,
	unlockConversation,
} from "./ask-background.js";

// --- Constants -------------------------------------------------------------

const AGY_DESCRIPTION = `Delegate a self-contained sub-task to Google Antigravity. agy is the CLI for Gemini, so this tool is reached under three equivalent names the user may use interchangeably: **gemini**, **antigravity**, and **agy**. When the user says "ask gemini", "ask antigravity", "ask agy", or otherwise refers to any of these, call THIS tool. agy runs its OWN tool loop: it can read, write, edit, and execute inside the workspace, then returns its final answer. Use for a second opinion from a different model family, Gemini-specific reasoning, or isolated sub-tasks you do not need to drive step-by-step. Provide a complete, self-contained task description; agy will not see this conversation.

TWO MODES (you choose):
- **One-shot (isolated)**: omit conversationId. agy starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the conversationId returned in the PREVIOUS call's details (details.conversationId). agy resumes that conversation with full context intact.

EXECUTION MODES (param: mode):
- **plan**: agy proposes a plan for review-shaped tasks. NOT a security boundary: the CLI does not gate writes under plan mode (upstream google-antigravity/antigravity-cli#1181, probed 2026-10-07: the write can execute in the same turn). The run additionally stages a temporary restricted agent whose toolset has no file-editing tools, as a damper, and the skip-permissions flag is never passed. Inline the material to review - a plan run cannot fetch it.
- **accept-edits**: agy applies edits directly inside the workspace. Default unless the configured mode is plan.

COMPACT OUTPUT (param: digest): when true, the prompt is prefixed to request compact digests instead of full file contents. Defaults on for plan, off for accept-edits.

THINKING LEVEL (params: thinking, effort - SYNONYMS for one knob):
- pi calls it thinking, agy calls it effort. Same thing. Pass ONE of the two.
- Values (pi vocabulary): minimal|low|medium|high|xhigh|max. Clamped to agy's low|medium|high; unknown values fall back to low. "peer review on high thinking" -> thinking: "high".
- An explicit level beats a tier embedded in model ("flash high") and the configured default. Omit both for the configured default.`;

// Delegations legitimately run long (research, review, analysis); a short
// default kills the run mid-task and the caller re-pays the whole prompt.
const DEFAULT_TIMEOUT_MIN = 30;
const GRACE_AFTER_TIMEOUT_MS = 5000;
const STATUS_INTERVAL_MS = 1000;
const STATUS_TAIL_CHARS = 160;

// renderCall / renderResult preview limits (match pi-claude-bridge).
const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;
const DISCOVERY_POLL_ATTEMPTS = 5;
const DISCOVERY_POLL_MS = 100;
// Buffer valves: a detached run can last days, so a runaway child must not grow
// these without bound.
const STDOUT_MAX_CHARS = 1_000_000;
const STDERR_MAX_CHARS = 65_536;

/** Parse raw `agy models` text into tool-catalog entries: the shared line
 *  grammar + hidden-family filter + static sonnet/opus overlay. Pure: no
 *  spawn. */
export function toolModelsFromRaw(raw: string): ModelEntry[] {
	return mergeCatalog(
		filterHiddenModels(
			raw
				.split("\n")
				.map(parseModelLine)
				.filter((e): e is ModelEntry => e !== null),
		),
	);
}

/** Query `agy models` and return tool-catalog entries. Returns [] on failure.
 *  Kept for standalone use; the extension entry spawns once and parses via
 *  toolModelsFromRaw to avoid a second `agy models` invocation. */
export async function discoverToolModels(binary: string): Promise<ModelEntry[]> {
	return toolModelsFromRaw(await spawnAgyModelsRaw(binary));
}

function extraArgs(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

// --- Prompt assembly: shared peer adapter ----------------------------------
// PLAN_HEADLESS_GUARD / AGENT_REVIEW_GUARD / buildFinalPrompt live in
// pi-ask-shared (peers/antigravity.ts); the bridge inherits the identical
// guard discipline. Re-exported for the bridge's own tests.
export { AGENT_REVIEW_GUARD, buildFinalPrompt, PLAN_HEADLESS_GUARD } from "./agy-peer.js";

// --- Plan-mode reviewer agent ----------------------------------------------

/** Temp agent dirs share the ~/.gemini/config/agents discovery root with the
 *  web delegates; AGY_AGENTS_ROOT overrides for tests and sandboxes. */
export function askAgentsRoot(): string {
	return process.env.AGY_AGENTS_ROOT ?? webAgentsRoot();
}

const ASK_AGENT_PREFIX = "pi-bridge-ask-";
const ASK_AGENT_TOOLS = ["view_file", "run_command"];

/** agent.md for the plan-mode reviewer. The tools list is a damper, not a
 *  guarantee: with no file-editing tool present the model has no edit tool in
 *  its menu (probed 2026-09-28 on agy 1.2.12: the toolset reports "none" for
 *  edits; re-verify on 1.3.x), but the CLI itself does not enforce
 *  review-only under plan mode (upstream google-antigravity/antigravity-cli
 *  #1181, probed 2026-10-07: the write can execute in the same turn).
 *  commandExecutionPolicy auto is what lets read commands run headless with
 *  no user allow rules. Never add a write-capable tool here. */
export function reviewerAgentMd(name: string): string {
	return [
		"---",
		`name: ${name}`,
		"description: Temporary Pi plan-mode reviewer",
		"mainAgent: true",
		"subagent: false",
		"model: inherit",
		"excludeDefaultComponents: true",
		"inheritCustomizations: false",
		"inheritMcp: false",
		"commandExecutionPolicy: auto",
		"tools:",
		...ASK_AGENT_TOOLS.map((t) => `  - ${t}`),
		"skills: []",
		"rules: []",
		"agents: []",
		"mcpServers: []",
		"---",
		"",
		"You are a strict read-only code reviewer. Review, analyze, and plan; never modify anything.",
		"",
	].join("\n");
}

/** Stage one unique reviewer agent (agent.md + pid marker) under root. Same
 *  hygiene doctrine as the web delegates: nonce-named, cleaned in finally,
 *  orphans swept by pid marker at registration. */
export function stageReviewerAgent(root: string): { name: string; dir: string } {
	fs.mkdirSync(root, { recursive: true });
	const name = `${ASK_AGENT_PREFIX}${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, "agent.md"), reviewerAgentMd(name), { mode: 0o600 });
	fs.writeFileSync(path.join(dir, ".pid"), `${process.pid}\n`, { mode: 0o600 });
	return { name, dir };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- One-shot agy run: shared by blocking and background -------------------

type AskLogFn = (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;

/** Tool-result shape the execute path returns; keeps the background helper's
 *  literals narrow. */
interface AskToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: AgyDetails;
}

/** Terminal result of one `agy -p` lifecycle. */
interface AgyOutcome {
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	/** Trimmed stdout. Empty means the headless auto-deny failure mode. */
	answerText: string;
}

/**
 * Spawns `agy -p` and resolves when its process tree closes. Blocking and
 * background runs share this lifecycle, including the delegation-suppression
 * window: agy WATCHES the global mcp_config and re-enables a hidden bridge
 * mid-run (observed live 2026-09-09), so the window must span the WHOLE run.
 * A background run outlives execute()'s return, which is why the window lives
 * here and not in the caller's finally.
 */
async function runAgyProcess(o: {
	binary: string;
	args: string[];
	cwd: string;
	timeoutMin: number;
	startAt: number;
	/** Mutated in place: conversationId discovery, stderr, outcome fields. */
	details: AgyDetails;
	isContinuation: boolean;
	snapshot: ReturnType<typeof snapshotConversations> | null;
	/** Blocking passes pi's per-call signal; background passes none on purpose:
	 *  a later Esc must not kill a detached run. */
	signal?: AbortSignal;
	/** Blocking only: throttled progress partials. */
	onPartial?: (text: string) => void;
	/** Background only: the tree kill switch, as soon as the child exists. */
	registerKill?: (kill: () => void) => void;
	/** Background only: the child closed; discovery/classification still run. */
	onClose?: () => void;
	log?: AskLogFn;
}): Promise<AgyOutcome> {
	const restoreBridge = acquireBridgeSuppression();
	let bridgeReleased = false;
	const releaseBridge = () => {
		if (bridgeReleased) return;
		bridgeReleased = true;
		restoreBridge();
	};
	let out = "";
	// Local: o.snapshot narrowing does not survive into the bind-poll closure.
	const snapshot = o.snapshot;
	const statusInterval = o.onPartial
		? setInterval(() => {
				const elapsed = Math.floor((Date.now() - o.startAt) / 1000);
				const tail = out.slice(-STATUS_TAIL_CHARS);
				o.onPartial!(tail ? `(running ${elapsed}s)\n…${tail}` : `(running ${elapsed}s)`);
			}, STATUS_INTERVAL_MS)
		: null;

	try {
		// Bind the conversation id DURING the run (agy is alive then) so the
		// pid-based /proc FD resolver can disambiguate when a concurrent agy
		// also drops a new .db. Awaited after the run; the post-exit loop
		// below is the fallback for runs that exit before the poll binds.
		let bindDuringRun: Promise<void> = Promise.resolve();
		const outcome = await new Promise<{
			exitCode: number;
			aborted: boolean;
			timedOut: boolean;
		}>((resolveP, rejectP) => {
			const proc = spawn(o.binary, o.args, {
				cwd: o.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				detached: true,
			});
			proc.stdout?.setEncoding("utf8");
			proc.stderr?.setEncoding("utf8");
			proc.stdout?.on("data", (d: string) => {
				if (out.length < STDOUT_MAX_CHARS) out += d;
			});
			proc.stderr?.on("data", (d: string) => {
				if (o.details.stderr.length < STDERR_MAX_CHARS) o.details.stderr += d;
			});

			// Concurrent bind: poll for the new id while agy is alive. The FD
			// resolver needs a live process tree, so this stops (and the post-
			// exit fallback below takes over) once agy has exited.
			if (!o.isContinuation && snapshot && proc.pid) {
				bindDuringRun = (async () => {
					for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
						if (o.details.conversationId) return;
						if (proc.exitCode !== null) return; // agy gone: scan useless now
						const found = newConversationId(CONVERSATIONS_DIR, snapshot, {
							pid: proc.pid,
						});
						if (found) {
							o.details.conversationId = found;
							return;
						}
						await sleep(DISCOVERY_POLL_MS);
					}
				})().catch(() => {
					/* best-effort: a bind error must never fail an otherwise-OK turn */
				});
			}

			let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
			let watchdog: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			let timedOut = false;

			const killTree = () => {
				try {
					if (proc.pid) process.kill(-proc.pid, "SIGTERM");
				} catch {
					/* process group already gone */
				}
				if (!sigkillTimer) {
					sigkillTimer = setTimeout(() => {
						try {
							if (proc.pid) process.kill(-proc.pid, "SIGKILL");
						} catch {
							/* give up */
						}
					}, GRACE_AFTER_TIMEOUT_MS);
				}
			};

			// Hand the kill switch over before the watchdog arms, so a stop can
			// land the moment the run exists.
			o.registerKill?.(killTree);

			const cleanup = () => {
				if (watchdog) clearTimeout(watchdog);
				if (sigkillTimer) clearTimeout(sigkillTimer);
				if (o.signal) o.signal.removeEventListener("abort", onAbort);
				releaseBridge();
				o.onClose?.();
			};
			const onAbort = () => killTree();

			watchdog = setTimeout(() => {
				timedOut = true;
				killTree();
			}, o.timeoutMin * 60_000);

			if (o.signal) {
				if (o.signal.aborted) killTree();
				else o.signal.addEventListener("abort", onAbort, { once: true });
			}

			const finish = (code: number | null) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolveP({
					exitCode: code ?? 0,
					aborted: !!o.signal?.aborted,
					timedOut,
				});
			};

			proc.on("error", (err) => {
				cleanup();
				rejectP(err);
			});
			// Settle on close, never on exit: exit can strand unread stdout
			// (a truncated answer) and would clear the SIGKILL escalation while
			// group members are still dying.
			proc.on("close", finish);
		});

		// Let the during-run bind poll finish (it bails immediately once agy has
		// exited, so this rarely blocks).
		await bindDuringRun;

		o.details.exitCode = outcome.exitCode;
		o.details.aborted = outcome.aborted;
		o.details.timedOut = outcome.timedOut;
		o.details.durationMs = Date.now() - o.startAt;
		o.log?.(
			"ask-end",
			{
				exitCode: outcome.exitCode,
				aborted: outcome.aborted,
				timedOut: outcome.timedOut,
				empty: !out.trim(),
				durationMs: o.details.durationMs,
				conversationId: o.details.conversationId,
			},
			outcome.exitCode !== 0 || outcome.aborted || outcome.timedOut || !out.trim() ? "warn" : "info",
		);

		if (!o.isContinuation && !o.details.conversationId && snapshot) {
			for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
				const found = newConversationId(CONVERSATIONS_DIR, snapshot);
				if (found) {
					o.details.conversationId = found;
					break;
				}
				await sleep(DISCOVERY_POLL_MS);
			}
		}

		return { ...outcome, answerText: out.trim() };
	} finally {
		if (statusInterval) clearInterval(statusInterval);
		// Belt and braces: cleanup() already releases on close/error; this
		// covers paths that never reached the process (sync spawn throw).
		releaseBridge();
	}
}

/**
 * Builds the model-facing answer for every terminal outcome. Pure except the
 * empty-output marker it stamps on details. Blocking and background share it
 * so both surfaces read identically.
 */
function shapeFinalText(details: AgyDetails, outcome: AgyOutcome, timeoutMin: number): string {
	const text = outcome.answerText;

	if (outcome.aborted) {
		return text ? `agy was aborted. Partial output:\n\n${text}` : "agy was aborted before producing output.";
	}

	if (outcome.timedOut) {
		const note = `agy exceeded the ${timeoutMin}m timeout and was killed`;
		return text ? `${text}\n\n[${note}]` : note;
	}

	if (outcome.exitCode !== 0) {
		// stderr can carry auth material; the note is chat-visible.
		const stderr = redactText(details.stderr.trim());
		const note = stderr
			? `agy exited with status ${outcome.exitCode}: ${stderr}`
			: `agy exited with status ${outcome.exitCode}`;
		return text ? `${text}\n\n[${note}]` : note;
	}

	// Exit 0 with nothing on stdout is still a failure for the delegator:
	// headless agy auto-denies a permission-gated tool call (e.g. the command
	// gate in plan mode), prints the reason only to stderr, and ends cleanly.
	// Falling through to the success path here returned just the conversation
	// footer, which read as an empty success (silent-failure bug 2026-09-25).
	if (!text) {
		details.empty = true;
		const stderr = redactText(details.stderr.trim());
		const note = [
			"agy exited cleanly but produced no output.",
			stderr ? `stderr: ${stderr}` : null,
			"Common cause: a tool call needed a permission that headless mode cannot prompt for (typically the command gate in plan mode), so it was auto-denied and the turn ended with no answer. Recovery: retry in plan mode with all needed content inlined in the prompt - plan runs cannot fetch it, commands are denied. Or rerun outside plan mode with skipPermissions, or add your own permissions.allow rules in ~/.gemini/antigravity-cli/settings.json.",
		]
			.filter(Boolean)
			.join(" ");
		return note;
	}

	const footer = details.conversationId
		? `\n\n[agy conversationId: ${details.conversationId} - pass as conversationId to continue this conversation]`
		: "";
	return text + footer;
}

// --- Registration ----------------------------------------------------------

/** Register the AskAntigravity tool. Call once from the extension entry.
 *  `entries` is the merged live+overlay catalog discovered at load. */
export async function registerAskAntigravityTool(
	pi: ExtensionAPI,
	entries: ModelEntry[],
	/** Daily file log sink (src/daily-log.ts). Records lifecycle, never
	 *  prompt text. Level matches DailyLogger: debug is the AGY_DEBUG-only
	 *  verbose tier; info/warn/error always land. */
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<void> {
	// Orphan sweep for the plan-mode reviewer agents (SIGKILL can skip the
	// run's finally): same pid-marker doctrine as the web delegates.
	try {
		sweepStaleWebAgents(askAgentsRoot(), Date.now(), ASK_AGENT_PREFIX);
	} catch {
		// a sweep failure must never block registration
	}
	// Fresh background state per extension load (a prior load's runs are killed,
	// never orphaned).
	resetBackgroundState();
	// Pi wipes module state on /new, /resume, /fork and /reload, and fires this
	// hook on all of them: in-flight background runs are killed and their result
	// is never delivered. The latch also silences the closing runs' wakes.
	pi.on?.("session_shutdown", () => disposeBackgroundRuns());
	/**
	 * Fire-and-forget background run: registry slot, detached agy, one wake on
	 * settle. No pi abort signal is passed on purpose - a later Esc must not
	 * kill a detached run.
	 */
	const startBackgroundRun = (o: {
		summary: string;
		binary: string;
		args: string[];
		cwd: string;
		timeoutMin: number;
		startAt: number;
		details: AgyDetails;
		modelLabel: string;
		isContinuation: boolean;
		snapshot: ReturnType<typeof snapshotConversations> | null;
		conversationId?: string;
		cleanupStaging: () => void;
	}): AskToolResult => {
		const conversationId = o.conversationId;
		if (conversationId && !lockConversation(conversationId)) {
			o.cleanupStaging();
			return {
				content: [
					{
						type: "text",
						text: `background refused: conversation ${conversationId} already has a run in flight. Wait for its result, or use blocking mode.`,
					},
				],
				details: { ...o.details, refused: true },
			};
		}
		let runId: string;
		try {
			runId = beginBackgroundRun(summarizePrompt(o.summary)).runId;
		} catch (err) {
			if (conversationId) unlockConversation(conversationId);
			o.cleanupStaging();
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: `background refused: ${msg}. Free a slot with /agy stop, or omit background.`,
					},
				],
				details: { ...o.details, refused: true },
			};
		}

		void runAgyProcess({
			binary: o.binary,
			args: o.args,
			cwd: o.cwd,
			timeoutMin: o.timeoutMin,
			startAt: o.startAt,
			details: o.details,
			isContinuation: o.isContinuation,
			snapshot: o.snapshot,
			registerKill: (kill) => registerBackgroundKill(runId, kill),
			onClose: () => markBackgroundFinishing(runId),
			log,
		})
			.then((outcome) => {
				const elapsedS = Math.round((Date.now() - o.startAt) / 1000);
				const handle = o.details.conversationId ? `conversationId=${o.details.conversationId}` : undefined;
				// stderr can carry auth material; wake content is redacted as a whole,
				// but a sliced secret can fall under the redactor's thresholds.
				const error = outcome.timedOut
					? `timeout after ${o.timeoutMin}m${outcome.answerText ? ` (partial: ${outcome.answerText.slice(0, 400)})` : ""}`
					: outcome.exitCode !== 0
						? redactText(o.details.stderr.trim()).slice(0, 400) || `exit status ${outcome.exitCode}`
						: !outcome.answerText
							? "agy exited cleanly but produced no output (headless auto-deny?)"
							: undefined;
				// The settle latch makes /agy stop and an unload win races against
				// this handler: a false return means their wake already went out.
				if (!settleBackgroundRun(runId, error ? "failed" : "done")) return;
				if (error) sendBackgroundWake(pi, { runId, ok: false, elapsedS, handle, error });
				else sendBackgroundWake(pi, { runId, ok: true, elapsedS, handle }, outcome.answerText);
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				if (!settleBackgroundRun(runId, "failed")) return;
				sendBackgroundWake(pi, { runId, ok: false, error: `failed to run agy: ${msg}` });
			})
			.finally(() => {
				endBackgroundRun(runId);
				if (conversationId) unlockConversation(conversationId);
				o.cleanupStaging();
			});

		return {
			content: [
				{
					type: "text",
					text: `Background run ${runId} started (model=${o.modelLabel}). The result arrives as a message when agy finishes, carrying the conversationId resume handle. Do not poll. Continue with other work or end the turn.`,
				},
			],
			details: { ...o.details },
		};
	};

	pi.registerTool({
		name: "AskAntigravity",
		label: "Ask Antigravity",
		description: AGY_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for agy. Include all context agy needs; it cannot see this conversation.",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Absolute workspace path agy runs in. Defaults to the current project root.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model alias or exact id. Friendly: 'flash', 'argon', 'gemini', 'sonnet', 'opus'. Add a tier: 'flash high', 'argon high'. Pin a version: '3.8 flash', '4 argon'. Exact: 'gemini-4-argon-high'. Omit for the configured default.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Thinking level (= agy effort tier). pi vocabulary: minimal|low|medium|high|xhigh|max, clamped to agy's low|medium|high (unknown values fall back to low). Overrides a tier embedded in `model`. Omit for the configured default.",
				}),
			),
			effort: Type.Optional(
				Type.String({
					description:
						"Alias for `thinking` (agy's own name for the same knob). Pass ONE of the two; different values on both is an error.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("plan"), Type.Literal("accept-edits")], {
					description:
						"agy execution mode. 'plan' = plan-shaped run: the CLI does not enforce review-only (see the tool description); the staged reviewer agent's toolset omits file-editing tools as a damper. 'accept-edits' = agy applies edits. Omit to follow the configured default (plan when config mode is plan, else accept-edits).",
				}),
			),
			digest: Type.Optional(
				Type.Boolean({
					description:
						"Request compact digests instead of full file contents. Defaults on for plan, off for accept-edits.",
				}),
			),
			conversationId: Type.Optional(
				Type.String({
					description:
						"Omit for a one-shot. To CONTINUE a previous agy conversation, pass the conversationId returned in that call's details.",
				}),
			),
			timeoutMinutes: Type.Optional(
				Type.Number({ description: `Hard cap on the agy run in minutes. Default ${DEFAULT_TIMEOUT_MIN}. Fractional minutes allowed; must be above 0 and at most ${MAX_TIMEOUT_MINUTES}. The prompt carries a matching [TIME BUDGET] notice.` }),
			),
			includeContext: Type.Optional(
				Type.Boolean({
					description:
						"When true, export the current pi conversation (resolved, as markdown) to a temp file inside the workspace and tell agy to read it first. Default false (isolated one-shot). Opt in only when the user explicitly wants agy to see the full conversation; it costs agy tokens to read.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Default false: blocking, you wait and get the answer in this call. If true: the run starts now, the call returns a bg_ runId at once, and when it ends a message arrives with the full answer and the conversationId resume handle. Do not poll, do not wait. Use it only when you have real independent work to do now, a late answer is acceptable, and you need no follow-up before the message arrives; with nothing else to do, blocking is strictly better (no extra turn). Never background a run that writes files you are editing. Not available in print/json mode.",
				}),
			),
		}),
		renderCall(args, theme, _context) {
			// Show RESOLVED model/thinking/mode (config defaults applied) so the
			// row identifies what will actually run, not just explicit args.
			const cfg = loadConfig();
			const requestedModel = (args.model as string | undefined)?.trim() || cfg.defaultModel;
			const thinkingArg = (args.thinking as string | undefined) ?? (args.effort as string | undefined);
			const resolved =
				resolveAgyModel(
					requestedModel,
					entries,
					cfg.defaultThinking,
					thinkingArg ? toAgyEffort(thinkingArg as ThinkingLevel, AGY_EFFORT_ORDER) : undefined,
				) ?? { model: requestedModel };
			const thinking: ThinkingTier = resolved.effort ?? cfg.defaultThinking;
			// Same default rule as execute: plan when the configured mode is
			// plan, so the row always names what will actually run.
			const mode: AgyMode =
				(args.mode as AgyMode | undefined) ?? (cfg.mode === "plan" ? "plan" : "accept-edits");
			const useDigest = typeof args.digest === "boolean" ? args.digest : mode === "plan";
			const isContinue =
				typeof args.conversationId === "string" && CONV_ID_RE.test(args.conversationId);

			const tags: string[] = [`model=${resolved.model}`, `thinking=${thinking}`];
			if (mode !== "accept-edits") tags.push(`mode=${mode}`);
			if (useDigest) tags.push("digest");
			if (isContinue) tags.push("continue");
			if (args.includeContext) tags.push("context=full");

			let text = theme.fg("mdLink", theme.bold("AskAntigravity "));
			text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;

			const prompt = String(args.prompt ?? "");
			const truncated = prompt.length > PREVIEW_MAX_CHARS ? prompt.slice(0, PREVIEW_MAX_CHARS) : prompt;
			const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
			text += theme.fg("muted", `"${lines.join("\n")}"`);
			if (prompt.length > PREVIEW_MAX_CHARS || prompt.split("\n").length > PREVIEW_MAX_LINES) {
				text += theme.fg("dim", " …");
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const d = result.details as AgyDetails | undefined;
			if (isPartial) {
				const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
				return new Text(theme.fg("mdLink", "◉ AskAntigravity ") + theme.fg("muted", status), 0, 0);
			}

			const body = result.content[0]?.type === "text" ? result.content[0].text : "";
			const errored = askResultErrored(d);

			let text = errored
				? theme.fg("error", "✗ AskAntigravity error")
				: theme.fg("mdLink", "✓ AskAntigravity");

			const rTags: string[] = [];
			if (d?.resolvedModel || d?.model) rTags.push(`model=${d?.resolvedModel ?? d?.model}`);
			if (d?.thinking) rTags.push(`thinking=${d.thinking}`);
			if (d?.mode && d.mode !== "accept-edits") rTags.push(`mode=${d.mode}`);
			if (d?.includeContext) rTags.push("context=full");
			if (rTags.length) text += ` ${theme.fg("accent", `[${rTags.join(", ")}]`)}`;
			if (d?.durationMs) text += ` ${theme.fg("dim", `${(d.durationMs / 1000).toFixed(1)}s`)}`;

			if (expanded) {
				if (body) text += `\n${theme.fg("toolOutput", body)}`;
			} else {
				const truncated = body.length > PREVIEW_MAX_CHARS ? body.slice(0, PREVIEW_MAX_CHARS) : body;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
				if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) {
					text += `\n${theme.fg("dim", `… (${expandHint(context)})`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Circular-delegation guard: refuse if already running through the
			// antigravity provider.
			if (ctx.model?.provider === "antigravity" || ctx.model?.provider === "agy") {
				return {
					content: [
						{
							type: "text",
							text: "Error: AskAntigravity cannot be used when the active provider is already antigravity - you're already running through it.",
						},
					],
					details: refusalDetails(),
				};
			}

			const config = loadConfig();
			// readOnly refusal (fail-closed): the kill switch covers this tool too.
			// It must not be bypassable with an explicit mode param: the CLI has no
			// review-only enforcement (upstream google-antigravity/antigravity-cli
			// #1181), so a plan-labeled run here is not read-only.
			if (config.readOnly) {
				return {
					content: [
						{
							type: "text",
							text: 'readOnly is on: AskAntigravity is refused (fail-closed; the agy CLI has no review-only enforcement, google-antigravity/antigravity-cli#1181). Run /agy readonly off to use this tool.',
						},
					],
					details: refusalDetails(),
				};
			}
			const requestedModel = (params.model as string | undefined) ?? config.defaultModel;
			if (typeof params.model === "string" && params.model.trim().startsWith("-")) {
				return {
					content: [
						{
							type: "text",
							text: `model value "${params.model}" starts with "-" - not a valid model id.`,
						},
					],
					details: refusalDetails(requestedModel),
				};
			}
			if (
				typeof params.thinking === "string" &&
				typeof params.effort === "string" &&
				params.thinking !== params.effort
			) {
				return {
					content: [
						{
							type: "text",
							text: "thinking and effort are synonyms for the same knob - pass one, not both with different values.",
						},
					],
					details: refusalDetails(requestedModel),
				};
			}
			const thinkingArg = (params.thinking as string | undefined) ?? (params.effort as string | undefined);
			const preferredTier = thinkingArg
				? toAgyEffort(thinkingArg as ThinkingLevel, AGY_EFFORT_ORDER)
				: undefined;
			const resolved =
				resolveAgyModel(requestedModel, entries, config.defaultThinking, preferredTier) ?? {
					model: requestedModel,
				};

			const start = Date.now();
			const cwd = params.cwd || ctx.cwd || process.cwd();
			try {
				const stat = fs.statSync(cwd);
				if (!stat.isDirectory()) {
					return {
						content: [{ type: "text", text: `cwd is not a directory: ${cwd}` }],
						details: refusalDetails(requestedModel, resolved.model),
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `cwd does not exist: ${cwd}` }],
					details: refusalDetails(requestedModel, resolved.model),
				};
			}

			const timeoutMin = params.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;
			if (!(timeoutMin > 0 && Number.isFinite(timeoutMin) && timeoutMin <= MAX_TIMEOUT_MINUTES)) {
				// timeoutMinutes: 0 would arm runProcess's watchdog with a 0ms
				// timeout (Node clamps to 1ms) and kill the peer instantly.
				return {
					content: [{ type: "text", text: `timeoutMinutes must be a positive number of minutes up to ${MAX_TIMEOUT_MINUTES} (for example 0.5 for 30 seconds).` }],
					details: refusalDetails(requestedModel, resolved.model),
				};
			}

			const rawConvId = params.conversationId;
			const isContinuation =
				typeof rawConvId === "string" && rawConvId.length > 0 && CONV_ID_RE.test(rawConvId);
			const snapshot = isContinuation ? null : snapshotConversations(CONVERSATIONS_DIR);

			const mode: AgyMode =
				(params.mode as AgyMode | undefined) ?? (config.mode === "plan" ? "plan" : "accept-edits");
			// Plan runs stage a restricted reviewer agent: its tools list has NO
			// file-editing tool, a toolset-level damper on edits (the prompt
			// guard alone was observed failing once - a sub-agent still edited
			// files; the CLI itself does not enforce review-only, upstream
			// #1181).
			// Staging failure degrades to the legacy fallback: no agent, no skip
			// flag, the stricter command-forbidding guard.
			let reviewerAgent: { name: string; dir: string } | null = null;
			if (mode === "plan") {
				try {
					reviewerAgent = stageReviewerAgent(askAgentsRoot());
				} catch {
					reviewerAgent = null;
				}
			}
			const useDigest: boolean =
				typeof params.digest === "boolean" ? params.digest : mode === "plan";
			// Budget notice into the prompt BEFORE buildFinalPrompt: the plan-mode
			// guard banners must stay the final text (last-read recency), so the
			// notice can't go after them. The builder itself stays notice-free so
			// callers can't double-wrap.
			const budget = buildTimeBudgetNotice(timeoutMin * 60_000);
			const finalPrompt: string = buildFinalPrompt(
				budget ? `${params.prompt}\n\n${budget}` : params.prompt,
				mode,
				useDigest,
				reviewerAgent !== null,
			);

			// Opt-in full-context export (isolated stays the default).
			let contextFile: string | null = null;
			if (params.includeContext) {
				try {
					const { messages } = buildSessionContext(ctx.sessionManager.getBranch());
					if (messages.length) {
						const md = renderAgentMessagesMarkdown(messages);
						const ctxDir = askContextDir();
						fs.mkdirSync(ctxDir, { recursive: true });
						contextFile = path.join(
							ctxDir,
							`.ask-context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
						);
						fs.writeFileSync(contextFile, md, { mode: 0o600 });
					}
				} catch {
					contextFile = null;
				}
			}
			const effectivePrompt = contextFile
				? `The full pi conversation context (as markdown) is at: ${contextFile}\nRead that file first for context, then do the task below.\n\n---\n\n${finalPrompt}`
				: finalPrompt;

			log?.(
				"ask-start",
				{ model: resolved.model, thinking: resolved.effort ?? config.defaultThinking, mode, digest: useDigest, continue: isContinuation, timeoutMin, background: !!params.background },
				"info",
			);
			// Build argv via the shared peer adapter (see buildAgyArgs there for
			// the flag-order contract and the fail-closed plan-run rules). The
			// bridge's permissions gate is truthy (`!== false`), so an unset
			// config counts as enabled - same knob as the provider.
			const args = buildAgyArgs({
				cwd,
				resolved,
				mode,
				reviewerAgentName: reviewerAgent?.name ?? null,
				skipPermissions: config.skipPermissions !== false,
				conversationId: isContinuation ? (rawConvId as string) : null,
				timeoutMinutes: timeoutMin,
				addDirs: contextFile ? [askContextDir()] : [],
				extraArgs: extraArgs(),
				prompt: effectivePrompt,
			});

			const details: AgyDetails = {
				model: requestedModel,
				resolvedModel: resolved.model,
				thinking: resolved.effort ?? config.defaultThinking,
				mode,
				digest: useDigest,
				conversationId: isContinuation ? (rawConvId as string) : null,
				includeContext: contextFile !== null,
				exitCode: 0,
				aborted: false,
				timedOut: false,
				durationMs: 0,
				stderr: "",
			};

			const binary = process.env.AGY_BIN || "agy";

			// Staged artifacts must outlive execute() in background mode (agy
			// reads them mid-run), so every exit path funnels through this.
			// Idempotent: safe on the refusal paths and again after the run.
			const cleanupStaging = () => {
				if (contextFile) {
					try {
						fs.unlinkSync(contextFile);
					} catch {}
				}
				if (reviewerAgent) {
					try {
						fs.rmSync(reviewerAgent.dir, { recursive: true, force: true });
					} catch {}
				}
			};

			// Background: hand the run to the registry and return at once. The
			// answer travels back as a wake message, not through this call. Refused
			// in print/json mode, where the process exits before the wake could
			// arrive.
			if (params.background) {
				if (ctx.mode === "print" || ctx.mode === "json") {
					cleanupStaging();
					return {
						content: [
							{
								type: "text",
								text: "background is not available in print/json mode: the process exits before the result message can arrive. Call again without background.",
							},
						],
						details: { ...details, refused: true },
					};
				}
				return startBackgroundRun({
					summary: params.prompt,
					binary,
					args,
					cwd,
					timeoutMin,
					startAt: start,
					details,
					modelLabel: resolved.model ?? requestedModel,
					isContinuation,
					snapshot,
					conversationId: isContinuation ? (rawConvId as string) : undefined,
					cleanupStaging,
				});
			}

			// One run per conversationId at a time, blocking included: a blocking
			// resume and a background resume of the same conversation would
			// interleave turns inside agy's session state.
			let locked: string | null = null;
			try {
				if (isContinuation && !lockConversation(rawConvId as string)) {
					return {
						content: [
							{
								type: "text",
								text: `conversation ${rawConvId} already has a run in flight. Wait for its result; if it is a background run, /agy stop can stop it.`,
							},
						],
						details: refusalDetails(requestedModel, resolved.model),
					};
				}
				locked = isContinuation ? (rawConvId as string) : null;

				const outcome = await runAgyProcess({
					binary,
					args,
					cwd,
					timeoutMin,
					startAt: start,
					details,
					isContinuation,
					snapshot,
					signal,
					onPartial: onUpdate
						? (partial) => {
								onUpdate({
									content: [{ type: "text", text: partial }],
									details: { ...details, durationMs: Date.now() - start },
								});
							}
						: undefined,
					log,
				});

				const finalText = shapeFinalText(details, outcome, timeoutMin);
				// Clear the last partial status line (claude-bridge idiom) so the
				// running-tail preview doesn't linger under the final answer.
				if (!outcome.aborted && !outcome.timedOut && outcome.exitCode === 0 && outcome.answerText) {
					onUpdate?.({ content: [{ type: "text", text: "" }], details: { ...details } });
				}
				return { content: [{ type: "text", text: finalText }], details };
			} catch (err) {
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				log?.("ask-fail", { error: msg, durationMs: details.durationMs }, "error");
				return { content: [{ type: "text", text: `failed to run agy: ${msg}` }], details };
			} finally {
				if (locked) unlockConversation(locked);
				cleanupStaging();
			}
		},
	});
}

// --- Full-context export (opt-in includeContext) --------------------------
// NOTE: duplicated per pi-ask-* / bridge package (each is self-contained).
// Duck-typed over role/content to tolerate AgentMessage's union + custom types.

// Tool-call inputs and tool-result bodies are clamped so the exported
// transcript stays reviewable; the agent can re-read any source file by path.
// User/assistant prose is kept in full (that IS the conversation).
const CONTEXT_BLOCK_MAX_CHARS = 2000;

function clampBlock(text: unknown, limit = CONTEXT_BLOCK_MAX_CHARS): string {
	const t = String(text ?? "");
	return t.length > limit ? `${t.slice(0, limit)}\n…[truncated, ${t.length - limit} more chars]` : t;
}

/** Render resolved pi AgentMessages to a readable markdown transcript.
 *  Pure: no IO. Caller writes the returned string to a temp file. */
function renderAgentMessagesMarkdown(messages: readonly unknown[]): string {
	const lines: string[] = [
		"# Pi conversation context",
		"",
		`_Exported for full-context delegation. ${messages.length} message(s)._`,
		"",
	];
	for (const raw of messages) {
		const m = raw as { role?: string; content?: unknown };
		const role = m.role ?? "message";
		const content = m.content;
		if (role === "assistant") {
			const blocks = (Array.isArray(content) ? content : []) as ReadonlyArray<{
				type: string;
				text?: string;
				name?: string;
				input?: unknown;
			}>;
			const text = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			if (text.trim()) lines.push("## Assistant", "", text, "");
			for (const b of blocks) {
				if (b.type === "toolCall" || b.type === "tool_use") {
					const input = clampBlock(
						typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""),
						500,
					);
					lines.push(`> tool call: ${b.name ?? "(unknown)"}(${input})`, "");
				}
			}
		} else if (role === "toolResult" || role === "tool_result" || role === "tool") {
			const text = contentText(content as any);
			if (text.trim()) lines.push("## Tool result", "", clampBlock(text), "");
		} else {
			const text = contentText(content as any);
			if (text.trim()) lines.push(`## ${role}`, "", clampBlock(text), "");
		}
	}
	return lines.join("\n");
}

/** Centralized scratch dir for full-context exports, following the
 *  ~/.pi/extensions-data/<author>/<extension>/ convention (see pi-token-cost-ledger).
 *  Derived from getAgentDir() so rebranded distros resolve correctly. */
function askContextDir(): string {
	return path.join(getAgentDir(), "antigravity-bridge", "ask-context");
}

interface AgyDetails {
	model: string | null;
	resolvedModel: string | null;
	thinking: ThinkingTier | null;
	mode: AgyMode;
	digest: boolean;
	conversationId: string | null;
	includeContext: boolean;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	// Exit 0 with no answer on stdout (the empty-output failure branch).
	// renderResult flips to the error glyph on it.
	empty?: boolean;
	/** Pre-run refusal or validation error: nothing ran, so no success glyph. */
	refused?: boolean;
	durationMs: number;
	stderr: string;
}

function refusalDetails(
	model: string | null = null,
	resolvedModel: string | null = null,
	thinking: ThinkingTier | null = null,
	includeContext: boolean = false,
): AgyDetails {
	return {
		model,
		resolvedModel,
		thinking,
		mode: "accept-edits",
		digest: false,
		includeContext,
		conversationId: null,
		exitCode: 0,
		aborted: false,
		timedOut: false,
		refused: true,
		durationMs: 0,
		stderr: "",
	};
}

/** True when the result row must show the error glyph. A refusal or a validation
 *  error never ran, so it must not render as a success. */
export function askResultErrored(d: Pick<AgyDetails, "exitCode" | "aborted" | "timedOut" | "empty" | "refused"> | undefined): boolean {
	return d?.exitCode !== 0 || !!d?.aborted || !!d?.timedOut || !!d?.empty || !!d?.refused;
}

/** Resolve the expand hint from the render context when Pi injects one.
 *  Pi 1.5 blinds an imported keyHint (an import may resolve to another copy of
 *  pi-coding-agent, which cannot see the host keybindings), so prefer the
 *  injected one and fall back to the import for Pi 1.4, which has neither. */
export function expandHint(context?: { keyHint?: typeof keyHint }): string {
	if (context?.keyHint) return context.keyHint("app.tools.expand", "to expand");
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		// The imported helper reads the interactive theme and throws outside it
		// (headless renders, tests). The description alone still tells the reader
		// what the key would do, which beats failing the render.
		return "to expand";
	}
}
