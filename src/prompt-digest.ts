import type { Message, TranscriptContext } from "@earendil-works/pi-ai";

/** Extract the latest user message as a flat prompt string. agy maintains its
 *  own conversation history via --conversation, so we collapse pi's structured
 *  message to text. Returns null if the last message isn't a user message. */
export function extractUserPrompt(context: TranscriptContext): string | null {
	const last = context.messages[context.messages.length - 1];
	if (!last || last.role !== "user") return null;
	const content = last.content;
	if (typeof content === "string") return content;
	// Flatten text blocks; images ride separately via extractImages (ACP only).
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim() || null;
}

/** Image blocks of the latest user message (pi-ai ImageContent: base64 data
 *  + mimeType). The ACP engine forwards them as typed content blocks; the
 *  stream-json CLI prompt is text-only, so its driver simply ignores these. */
export function extractImages(context: TranscriptContext): Array<{ data: string; mimeType: string }> {
	const last = context.messages[context.messages.length - 1];
	if (!last || last.role !== "user" || typeof last.content === "string") return [];
	return last.content
		.filter((b): b is { type: "image"; data: string; mimeType: string } => b.type === "image")
		.map((b) => ({ data: b.data, mimeType: b.mimeType }));
}
// --- G1: pi-side context digest --------------------------------------------------
//
// agy keeps its OWN conversation history (resumed via --conversation), so it
// already holds every turn it produced. What it lacks is pi-side context it was
// never spawned for: pi's compaction summaries and turns handled by OTHER
// providers (or pi's own tools). pi materializes all of that into
// context.messages every turn (verified: session-manager.js -> convertToLlm),
// so we build a DELTA digest from those messages and prepend it to the prompt.
// No pi patch, no new MCP tool. See docs/PI-BRIDGE-GAPS.md (G1).

const COMPACTION_MARKER = "compacted into the following summary";

export const DIGEST_PREAMBLE =
	"[The following is context from the broader pi session that this Antigravity turn was not directly spawned for: compaction summaries and turns handled by other providers or pi's own tools. Your own prior turns are already in your conversation history. Use this for continuity only.]";

// --- pi system prompt (G10) ----------------------------------------------------
//
// pi normalizes the system prompt into the transcript every turn (read via
// getCurrentSystemPrompt): its own operating instructions
// plus every AGENTS.md/CLAUDE.md it loaded (global agent dir first, then
// ancestors). The provider used to drop it, so agy models never saw the user's
// machine-level or project-level instructions. agy has no system-prompt flag
// (verified against `agy --help`), so the only delivery path is the prompt
// text. We prepend it as a delimited block on the FIRST prompt of a fresh
// conversation only: agy keeps its own history, the block stays byte-identical
// afterwards, and agy's server-side prompt cache keeps hitting.

export const SYSTEM_PROMPT_PREAMBLE =
	"[The following is the system prompt of the pi session that spawned this conversation: operating instructions plus project context (AGENTS.md files). Apply it for this whole conversation.]";

export const SYSTEM_PROMPT_END = "[END SYSTEM PROMPT]";

/** Brief tool-priority note appended inside every system prompt block: agy
 *  runs embedded in pi, so its native interactive tools never reach the
 *  user. Equivalent Pi Bridge tools must win. Concrete clashes observed
 *  live: agy picked its native ask_question over the bridge's
 *  ask_user_question and the question never displayed; on ACP its native
 *  view_file rejects real filesystem paths (artifact sandbox), so reads of
 *  the user's machine must go through the bridge. Rides the systemPrompt
 *  gate: the note ships only when the system prompt ships. */
export const TOOL_PRIORITY_NOTE =
	"[Tool priority: this conversation runs inside pi, not as a standalone agy session; the user only sees what surfaces in pi. Native interactive tools, for example ask_question, never reach the user. When a Pi Bridge tool covers the same purpose, always use the Pi Bridge tool; for user questions use ask_user_question. Your native file tools such as view_file only read brain artifacts and reject real filesystem paths; for any path on the user's machine use the Pi Bridge tools (read, ls, grep, find, edit, execute). Delegate subagent work the same way: when pi's tool list includes a delegation tool (for example subagent, Agent, agent_spawn, agent_wait, or subagent_run), always delegate through it and never through the native invoke_subagent, run_subagent, or manage_subagents; use native ones only if no pi delegation tool is listed, because native subagents run inside agy and are invisible to pi and anything watching it. Long-running bridge calls do not fail: after ~20 seconds the bridge answers STILL RUNNING with a callId; fetch the result with bridge_poll_result and poll until it lands. For work you already know is long, prefer exec_command's session-output pattern or background agents so you keep working while it runs. Token conservation: bound tool outputs to protect token budget and avoid quota exhaustion. Always use line ranges (StartLine/EndLine) when viewing files larger than ~100 lines instead of dumping full files, and bound shell commands with head, tail, or --stat rather than printing massive logs or diffs.]";

/** Assemble the full agy prompt: system prompt block, pi-side digest, user
 *  prompt. Empty parts are dropped. Pure; exported for unit testing.
 *  Pass systemPrompt only on a fresh conversation (see runTurnDriver). */
export function buildFullPrompt(
	systemPrompt: string | undefined,
	digest: string,
	prompt: string,
): string {
	const parts: string[] = [];
	if (systemPrompt) {
		parts.push(`${SYSTEM_PROMPT_PREAMBLE}\n\n${systemPrompt}\n\n${TOOL_PRIORITY_NOTE}\n\n${SYSTEM_PROMPT_END}`);
	}
	if (digest) {
		parts.push(`${DIGEST_PREAMBLE}\n\n${digest}`);
	}
	if (prompt) {
		parts.push(prompt);
	}
	return parts.join("\n\n---\n\n");
}

/** Flatten any message content shape (string or content-block array) to text.
 *  Drops images, thinking, and tool-call blocks. */
export function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

/** A compaction summary arrives wrapped in pi's boilerplate prefix/suffix.
 *  Return just the summary body. */
function stripCompactionWrapping(t: string): string {
	const open = t.indexOf("<summary>");
	const close = t.lastIndexOf("</summary>");
	if (open >= 0 && close > open) return t.slice(open + "<summary>".length, close).trim();
	return t.trim();
}

export interface DigestOptions {
	/** Provider id whose assistant turns are already in agy's own DB and so
	 *  must be skipped to avoid double-counting. Default "antigravity". */
	ownProvider?: string;
	/** Soft cap on the digest body (0 = unbounded). Default 8000. */
	maxChars?: number;
	/** Conversation binding state. bound=true (default): own-provider turns
	 *  are already in agy's resumed DB and are skipped. bound=false: the agy
	 *  conversation holds NOTHING (fresh conversation from a mid-session
	 *  model switch, an engine switch, or recreation recovery), so
	 *  own-provider turns and their tool results ship too. */
	bound?: boolean;
	/** Compaction summary identity already delivered in a previous digest
	 *  (compactionFingerprint of the stripped summary text). Index identity
	 *  is wrong: pi rebuilds post-compaction transcripts with the summary at
	 *  the front, so every compaction lands at the same index; content
	 *  identity ships a NEW summary exactly once. */
	seenSummaryId?: string;
	/** Include the trailing message in the delta window instead of reserving
	 *  it as the current user prompt. Used when resuming into a fresh
	 *  post-compaction conversation whose transcript ends in a toolResult or
	 *  assistant message. Default false. */
	includeLast?: boolean;
}

/** Soft cap on the digest body when no tighter budget applies. */
export const DIGEST_MAX_CHARS = 8000;

/** stream-json single-prompt silent-drop cap (issue #2, probed 2026-09-30):
 *  the CLI drops any prompt past ~25KB with SUCCESS and an empty response,
 *  and the dropped turn leaves the conversation permanently unresponsive. */
export const STREAM_JSON_PROMPT_CAP = 25_000;
/** Headroom under the cap for prompt framing. */
export const STREAM_JSON_PROMPT_MARGIN = 4_096;

/** Smallest digest budget under which the delta truncator can still mark a
 *  cut ("[truncated]" + separator + one kept byte). Below it
 *  buildContextDigest returns "" even when delta parts are pending; the
 *  provider uses this floor to tell a squeezed byte-budget skip apart from a
 *  genuinely empty delta window (S4: a skip must not consume the delta). */
export const DIGEST_TRUNCATION_FLOOR_CHARS = 13;

/** Per-engine digest cap. ACP ships the digest as an embeddedContext
 *  resource block: no prompt cap applies, so the default cap stands. On
 *  stream-json the digest rides inline in the prompt, so it must fit under
 *  the silent-drop budget alongside the user's own prompt bytes. Returns
 *  null when the budget is already exhausted (ship nothing rather than a
 *  digest that would push the turn over the drop cap). */
export function digestMaxCharsForEngine(engine: string, promptBytes: number): number | null {
	if (engine === "acp") return DIGEST_MAX_CHARS;
	const budget = STREAM_JSON_PROMPT_CAP - promptBytes - STREAM_JSON_PROMPT_MARGIN;
	return budget > 0 ? Math.min(DIGEST_MAX_CHARS, budget) : null;
}

/** role:timestamp fingerprint of the message a watermark points at (the
 *  digest boundary). A transcript mutated under the stored count (/tree,
 *  /fork, per-call context-hook rewrites) changes the boundary message, so a
 *  stored fingerprint that no longer matches invalidates the delta window
 *  and the digest falls back to the full delta. */
export function boundaryFingerprint(m: Message | undefined): string | undefined {
	return m ? `${m.role}:${m.timestamp}` : undefined;
}

/** Index of the most recent compaction summary in the transcript, -1 if none. */
export function findLastCompactionIdx(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (blocksToText(m.content).includes(COMPACTION_MARKER)) return i;
	}
	return -1;
}

/** Content identity of a compaction summary message (length + FNV-1a of the
 *  stripped text). pi puts every post-compaction summary at the transcript
 *  front, so index identity would swallow the second compaction; this id
 *  ships a new summary exactly once. */
export function compactionFingerprint(m: Message): string {
	const text = stripCompactionWrapping(blocksToText(m.content));
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** Build a delta digest of pi-side context agy was not spawned for: the most
 *  recent undelivered compaction summary plus turns since the watermark that
 *  were not produced by this provider (in bound mode). Pure: no I/O.
 *  Exported for unit testing.
 *
 *  Delta, not replay: in bound mode skip our own assistant turns
 *  (provider === ownProvider) - they are already in agy's resumed DB. In
 *  fresh mode (bound: false) the conversation holds nothing, so own turns
 *  ship too.
 *
 *  Compaction-aware reset: a compaction can shrink the transcript below the
 *  stored watermark, which would empty the delta window and silently drop
 *  every post-compaction turn. The window instead restarts after the
 *  compaction, and the summary itself ships exactly once (tracked by
 *  seenSummaryId, content-keyed) to keep steady-state prompts byte-stable.
 *
 *  Fidelity note: other-provider assistant turns contribute only their text
 *  blocks; tool-call and thinking blocks are dropped. The intent (which tool)
 *  is lost, but their results still surface separately as toolResult messages. */
export function buildContextDigest(
	messages: Message[],
	watermark: number,
	opts: DigestOptions = {},
): string {
	const own = opts.ownProvider ?? "antigravity";
	const maxChars = opts.maxChars ?? DIGEST_MAX_CHARS;
	if (messages.length === 0) return "";

	const deltaParts: string[] = [];

	// 1. Compaction summary (never in agy's DB, so always high-value), but
	//    only when THIS summary has not shipped in a previous digest.
	const compactionIdx = findLastCompactionIdx(messages);
	let summaryPart: string | null = null;
	if (compactionIdx >= 0) {
		const summaryMessage = messages[compactionIdx];
		if (compactionFingerprint(summaryMessage) !== opts.seenSummaryId) {
			summaryPart = `[pi compaction summary]\n${stripCompactionWrapping(blocksToText(summaryMessage.content))}`;
		}
	}

	// 2. Delta window. Two stale-watermark shapes both clamp to after the
	//    compaction: a watermark below it (pre-compaction history is dropped
	//    or summarized) and a watermark above the transcript (the compaction
	//    shrank the list under the stored count; without the clamp the window
	//    would be empty and every post-compaction turn silently dropped).
	//    Without a compaction, a watermark above the transcript (branch/prune
	//    without a marker) falls back to the full delta.
	let start = Math.max(0, Math.floor(watermark));
	if (compactionIdx >= 0) {
		if (start < compactionIdx + 1 || watermark > messages.length) start = compactionIdx + 1;
	} else if (watermark > messages.length) {
		start = 0;
	}
	const end = opts.includeLast ? messages.length : Math.max(0, messages.length - 1);
	for (let i = start; i < end; i++) {
		const m = messages[i];
		if (m.role === "assistant") {
			if (opts.bound !== false && m.provider === own) continue; // our own turn: already in agy's DB
			const t = blocksToText(m.content).trim();
			if (!t) continue;
			deltaParts.push(`[assistant turn from ${m.provider}]\n${t}`);
		} else if (m.role === "user") {
			const t = blocksToText(m.content);
			if (t.includes(COMPACTION_MARKER)) continue; // delivered as the summary part
			if (!t.trim()) continue;
			deltaParts.push(`[earlier user message]\n${t}`);
		} else if (m.role === "toolResult") {
			const t = blocksToText(m.content).trim();
			deltaParts.push(
				`[tool result: ${m.toolName}${m.isError ? " (error)" : ""}]\n${t || "(no text output)"}`,
			);
		}
	}

	// Assemble. The compaction summary is clamped to the budget (head kept:
	// a summary reads top-down, and an oversized one must not push a
	// stream-json turn over the silent-drop cap). The DELTA is truncated from
	// the newest end backward when over budget: recent context matters more
	// for continuity than older detail, so drop the oldest delta first. If
	// even the newest single item exceeds the budget, keep its tail slice.
	const SEP = "\n\n";
	const MARKER = "[truncated]";
	if (summaryPart && maxChars > 0 && summaryPart.length > maxChars) {
		const room = Math.max(0, maxChars - MARKER.length - 1);
		summaryPart = `${summaryPart.slice(0, room)}\n${MARKER}`;
	}
	let delta = deltaParts.join(SEP);
	if (maxChars > 0) {
		const budget = Math.max(0, maxChars - (summaryPart ? summaryPart.length + SEP.length : 0));
		if (delta.length > budget) {
			const kept: string[] = [];
			let used = 0;
			for (let i = deltaParts.length - 1; i >= 0; i--) {
				const cost = deltaParts[i].length + (kept.length > 0 ? SEP.length : 0);
				if (used + cost > budget) break;
				kept.unshift(deltaParts[i]);
				used += cost;
			}
			if (kept.length > 0) {
				delta = `${MARKER}\n${kept.join(SEP)}`;
			} else {
				const room = Math.max(0, budget - MARKER.length - 1);
				delta = room > 0 ? `${MARKER}\n${deltaParts[deltaParts.length - 1].slice(-room)}` : "";
			}
		}
	}

	return [summaryPart, delta]
		.filter((s): s is string => typeof s === "string" && s.length > 0)
		.join(SEP);
}
