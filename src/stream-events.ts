// agy stream-json NDJSON event types + parser.
//
// `agy --input-format stream-json --output-format stream-json` emits one JSON
// object per line on stdout: `init` (conversation binding), `step_update`
// (user_input / agent_response / checkpoint / tool steps), `result` (terminal).
// Shapes captured from live output. Unknown event kinds parse as
// {kind:"unknown"} so a future agy release degrades instead of crashing the
// reader loop.

export interface AgyUsage {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	total_tokens?: number;
}

export type AgyStepState = "ACTIVE" | "DONE" | "ERROR" | string;
export type AgyStepType = "user_input" | "checkpoint" | "agent_response" | "tool" | (string & {});

export interface AgyToolInfo {
	name?: string;
	parameters?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface AgyStepUpdate {
	step_index?: number;
	state?: AgyStepState;
	step_type?: AgyStepType;
	conversation_id?: string;
	tool_name?: string;
	tool_info?: AgyToolInfo;
	response_text?: string;
	/** Live agy (1.1.13+): agent_response deltas arrive here, not in response_text. */
	text_delta?: string;
	thought_text?: string;
	thinking_tokens?: number;
	thinking_signature?: string;
	duration_seconds?: number;
	error_message?: string;
	usage?: AgyUsage;
	[key: string]: unknown;
}

export interface AgyResult {
	status?: string;
	response?: string;
	error?: string;
	usage?: AgyUsage;
	conversation_id?: string;
	[key: string]: unknown;
}

export type ParsedAgyEvent =
	| { kind: "init"; conversationId?: string; usage?: AgyUsage }
	| { kind: "step"; step: AgyStepUpdate }
	| { kind: "result"; result: AgyResult }
	| { kind: "unknown"; raw: unknown };

/** Parse one stdout line. Never throws; bad JSON / non-objects become "unknown". */
export function parseAgyLine(line: string): ParsedAgyEvent {
	const trimmed = line.trim();
	if (!trimmed) return { kind: "unknown", raw: null };
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return { kind: "unknown", raw: trimmed.slice(0, 200) };
	}
	if (typeof obj !== "object" || obj === null) return { kind: "unknown", raw: obj };
	const rec = obj as Record<string, unknown>;
	if (rec.event === "init" && typeof rec.init === "object" && rec.init !== null) {
		const init = rec.init as Record<string, unknown>;
		return {
			kind: "init",
			conversationId:
				typeof init.conversation_id === "string" ? init.conversation_id : undefined,
			usage: isUsage(init.usage) ? init.usage : undefined,
		};
	}
	if (rec.event === "step_update" && typeof rec.step_update === "object" && rec.step_update !== null) {
		return { kind: "step", step: rec.step_update as AgyStepUpdate };
	}
	if (rec.event === "result" && typeof rec.result === "object" && rec.result !== null) {
		return { kind: "result", result: rec.result as AgyResult };
	}
	// Tolerate top-level shorthand: some agy builds put the payload at the root.
	if (rec.event === "init") {
		return {
			kind: "init",
			conversationId: typeof rec.conversation_id === "string" ? rec.conversation_id : undefined,
			usage: isUsage(rec.usage) ? (rec.usage as AgyUsage) : undefined,
		};
	}
	if (typeof rec.step_type === "string") return { kind: "step", step: rec as AgyStepUpdate };
	if (typeof rec.status === "string") return { kind: "result", result: rec as AgyResult };
	return { kind: "unknown", raw: obj };
}

function isUsage(u: unknown): u is AgyUsage {
	return typeof u === "object" && u !== null;
}

/** Map agy usage onto pi-ai's Usage (cost stays zero: subscription quota). */
export function toPiUsage(
	u: AgyUsage | undefined,
	piUsage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
): void {
	if (!u) return;
	// The LATEST step wins for every counter it reports. `Math.max` latched the
	// previous step's peak: with prompt caching agy reports the UNCACHED
	// remainder as input_tokens and the cached prefix as cache_read_tokens, so
	// a high uncached first step would stick to every later step (and pi's
	// context occupancy with it). A frame that omits input_tokens keeps the
	// known count.
	if (u.input_tokens !== undefined) piUsage.input = u.input_tokens;
	piUsage.output = u.output_tokens ?? piUsage.output;
	piUsage.cacheRead = u.cache_read_tokens ?? piUsage.cacheRead;
	// agy's total_tokens covers uncached input + output only; the cached prefix
	// is real occupancy too (a 14k cache hit on a 2.2k uncached step reported
	// total 2,234). Count it whenever the step reports cache reads and its own
	// total does not already include them.
	const cachedInput = piUsage.input + piUsage.cacheRead;
	piUsage.totalTokens =
		u.cache_read_tokens !== undefined &&
		u.cache_read_tokens > 0 &&
		(u.total_tokens === undefined || u.total_tokens < cachedInput)
			? Math.max(u.total_tokens ?? 0, cachedInput + piUsage.output)
			: Math.max(u.total_tokens ?? 0, piUsage.input + piUsage.output);
}

/**
 * Prevent pi-ai's silent-overflow detector (`isContextOverflow` Case 2) from
 * false-triggering on multi-inference billing sums (S1, upstream 1.13.0).
 *
 * In multi-step turns (several tool inferences inside one prompt), agy sums
 * `input_tokens` and `cache_read_tokens` across every inference. When live
 * occupancy (`totalTokens`) fits inside `contextWindow` but
 * `input + cacheRead` exceeds it, scale `input` and `cacheRead`
 * proportionally to fit within the single-turn budget (preserving the
 * cache-hit ratio). Normal turns (`input + cacheRead <= contextWindow`) and
 * genuine silent overflows (`totalTokens > contextWindow`) are left
 * untouched. Defense-in-depth on this fork: the activity-level usage guard
 * already rejects oversized candidates while the transcript is far from the
 * window; this catches anything that still reaches the settle path.
 */
export function clampOverflowUsage(
	usage: { input: number; output: number; cacheRead: number; totalTokens: number },
	contextWindow: number | undefined,
): void {
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return;
	if (!Number.isFinite(usage.totalTokens) || usage.totalTokens <= 0) return;
	if (usage.totalTokens > contextWindow) return;
	if (!Number.isFinite(usage.input) || !Number.isFinite(usage.cacheRead)) return;
	if (usage.input < 0 || usage.cacheRead < 0) return;
	const rawInput = usage.input + usage.cacheRead;
	if (rawInput <= contextWindow) return;

	const target =
		Number.isFinite(usage.output) && usage.output >= 0 && usage.output < usage.totalTokens
			? usage.totalTokens - usage.output
			: usage.totalTokens;
	const scaledInput = Math.min(target, Math.max(0, Math.round((usage.input / rawInput) * target)));
	usage.input = scaledInput;
	usage.cacheRead = target - scaledInput;
}
