// Provider effort-mapping tests. Drives createStreamSimple with an injected
// fake driver (no agy spawn, no network) and asserts how the provider
// translates pi's options.reasoning into the agy --effort tier: forwarded
// for effort-driven bases, clamped to the base's supported tiers, omitted
// for fixed-thinking models. toAgyEffort itself is pinned by a pure unit test.
//
// The legacy provider event-mapping tests (close-on-switch, tool labels,
// empty turn) died with the legacy-sqlite engine; the stream-json path is
// covered by tests/stream-roundtrip.test.ts.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	createAssistantMessageEventStream,
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ToolRoundTrips, WrapperReplay, consumeActivity, createStreamSimple, STREAM_JSON_PROMPT_CAP, STREAM_JSON_PROMPT_MARGIN, SYSTEM_PROMPT_PREAMBLE, TOOL_PRIORITY_NOTE, type BlockState } from "../src/provider.js";
import { toAgyEffort } from "../src/models.js";
import { TurnDiffContext } from "../src/diff-render.js";
import { SessionStore } from "../src/sessions.js";
import { setCachedQuotaReport } from "../src/usage.js";
import { resetSyspromptAgentForTests } from "../src/sysprompt-agent.js";
import type { DriverActivity, StreamDriver, DriverTurnRequest, TurnHandle } from "../src/driver.js";

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini 3.6 Flash (Medium)",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function contextWith(prompt: string): TranscriptContext {
	return normalizeContext({
		systemPrompt: undefined,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	});
}

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-prov-")), "sessions.json");
}

/** A fake driver that records the run() opts so a test can assert how the
 *  provider translated pi's options into agy turn opts. The handle emits no
 *  activities and settles OK. */
function capturingDriver(seen: { opts?: DriverTurnRequest }): StreamDriver {
	return {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			return {
				id: "fake-turn",
				outcome: Promise.resolve({
					status: "OK",
					response: "ok",
					finished: true,
					aborted: false,
				}),
				next: async () => null,
				pushExternal: () => {},
			};
		},
	} as unknown as StreamDriver;
}

/** Run one scripted turn through streamSimple; returns the captured turn
 *  request the provider handed to the driver. */
async function captureTurn(
	entry: { full: string; id: string; efforts?: ("low" | "medium" | "high")[] },
	reasoning: string | undefined,
): Promise<DriverTurnRequest | undefined> {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const streamSimple = createStreamSimple({
		entries: [entry],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const stream = streamSimple(
		{ ...model, id: entry.id },
		contextWith("ignored by fake"),
		{ cwd: process.cwd(), reasoning } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
	return seen.opts;
}

test("toAgyEffort maps pi levels onto the base's supported tiers (clamped)", () => {
	const flash = ["low", "medium", "high"] as const;
	const pro = ["low", "high"] as const;
	assert.equal(toAgyEffort("low", flash), "low");
	assert.equal(toAgyEffort("medium", flash), "medium");
	assert.equal(toAgyEffort("high", flash), "high");
	assert.equal(toAgyEffort("minimal", flash), "low");
	// Pro has no medium -> clamp up to nearest available (high).
	assert.equal(toAgyEffort("medium", pro), "high");
	assert.equal(toAgyEffort("low", pro), "low");
	assert.equal(toAgyEffort("high", pro), "high");
	// No level -> default to the cheapest available tier.
	assert.equal(toAgyEffort(undefined, flash), "low");
	assert.equal(toAgyEffort(undefined, pro), "low");
});

test("streamSimple forwards image blocks from the user message to the driver", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const context: TranscriptContext = normalizeContext({
		systemPrompt: undefined,
		messages: [
			{
				role: "user",
				timestamp: Date.now(),
				content: [
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					{ type: "text", text: "What is this?" },
				],
			},
		],
	});
	const stream = streamSimple(
		{ ...model, id: "gemini-flash" },
		context,
		{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
	// Text rides as the prompt; images ride separately (the stream driver
	// ignores them, the ACP driver forwards them as typed content blocks).
	assert.equal(seen.opts?.prompt, "What is this?");
	assert.deepEqual(seen.opts?.images, [{ data: "aGVsbG8=", mimeType: "image/png" }]);
});

test("streamSimple forwards the config turn caps to the driver", async () => {
	const prevTurn = process.env.AGY_TURN_TIMEOUT_MIN;
	const prevIdle = process.env.AGY_INACTIVITY_TIMEOUT_MIN;
	const prevHome = process.env.HOME;
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-home-"));
	process.env.HOME = tmpHome;
	try {
		process.env.AGY_TURN_TIMEOUT_MIN = "45";
		process.env.AGY_INACTIVITY_TIMEOUT_MIN = "5";
		const entry = { full: "gemini-3.6-flash", id: "gemini-flash" };
		const opts = await captureTurn(entry, undefined);
		assert.equal(opts?.timeoutMin, 45);
		assert.equal(opts?.inactivityMin, 5);
		// 0 = disable: the value must reach the driver verbatim, not fall back
		// to the driver-side default of 10.
		process.env.AGY_TURN_TIMEOUT_MIN = "0";
		const disabled = await captureTurn(entry, undefined);
		assert.equal(disabled?.timeoutMin, 0);
		// Unset: the TTY-aware default resolves (vitest stdio is piped: 20).
		delete process.env.AGY_TURN_TIMEOUT_MIN;
		const fallback = await captureTurn(entry, undefined);
		assert.equal(fallback?.timeoutMin, 20);
		assert.equal(fallback?.inactivityMin, 5);
	} finally {
		process.env.HOME = prevHome;
		try {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {}
		if (prevTurn === undefined) delete process.env.AGY_TURN_TIMEOUT_MIN;
		else process.env.AGY_TURN_TIMEOUT_MIN = prevTurn;
		if (prevIdle === undefined) delete process.env.AGY_INACTIVITY_TIMEOUT_MIN;
		else process.env.AGY_INACTIVITY_TIMEOUT_MIN = prevIdle;
	}
});

test("streamSimple routes Claude models to streamDriver even when engine is acp", async () => {
	const streamSeen: { opts?: DriverTurnRequest } = {};
	const acpSeen: { opts?: DriverTurnRequest } = {};
	const streamDriver = capturingDriver(streamSeen);
	const acpDriver = capturingDriver(acpSeen);
	const store = new SessionStore(tmpStorePath());
	const entries = [
		{ full: "gemini-4-argon", id: "gemini-4-argon" },
		{ full: "claude-opus-5-5", id: "claude-opus-5-5" },
	];
	const roundTrips = new ToolRoundTrips(streamDriver);

	const streamSimple = createStreamSimple({
		entries,
		store,
		driver: streamDriver,
		acpDriver,
		roundTrips,
		engine: "acp",
	});

	// Gemini model -> routed to acpDriver
	const geminiTurn = streamSimple(
		{ ...model, id: "gemini-4-argon" },
		contextWith("hello gemini"),
		{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
	);
	for await (const ev of geminiTurn) void ev;
	assert.ok(acpSeen.opts, "gemini must run on acpDriver");
	assert.equal(acpSeen.opts.prompt, "hello gemini");

	// Claude model -> routed to streamDriver (stream-json)
	const claudeTurn = streamSimple(
		{ ...model, id: "claude-opus-5-5" },
		contextWith("hello claude"),
		{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
	);
	for await (const ev of claudeTurn) void ev;
	assert.ok(streamSeen.opts, "claude must run on streamDriver");
	assert.equal(streamSeen.opts.prompt, "hello claude");
});

/** Context with a prior foreign-provider assistant turn, so the G1 digest
 *  has real content to deliver (buildContextDigest skips the current prompt). */
function digestContext(): TranscriptContext {
	return normalizeContext({
		systemPrompt: undefined,
		messages: [
			{ role: "user", content: "earlier", timestamp: Date.now() },
			{
				role: "assistant",
				provider: "claude",
				content: [{ type: "text", text: "claude says hi" }],
				timestamp: Date.now(),
				model: "claude-sonnet-4-6",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				api: "anthropic-messages",
			},
			{ role: "user", content: "current", timestamp: Date.now() },
		],
	});
}

test("streamSimple: acp engine ships the digest as a contextBlock, not inline", async () => {
	process.env.AGY_ENGINE = "acp";
	process.env.AGY_DIGEST = "1";
	try {
		const seen: { opts?: DriverTurnRequest } = {};
		const driver = capturingDriver(seen);
		const streamSimple = createStreamSimple({
			entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
			store: new SessionStore(tmpStorePath()),
			driver,
			acpDriver: driver,
			roundTrips: new ToolRoundTrips(driver),
		});
		const stream = streamSimple(
			{ ...model, id: "gemini-flash" },
			digestContext(),
			{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
		);
		for await (const ev of stream) void ev;
		// Digest rides as the embeddedContext resource block...
		assert.ok(seen.opts?.contextBlock, "contextBlock present");
		assert.equal(seen.opts.contextBlock.uri, "urn:pi-bridge:context-digest/3");
		// The digest block carries the framing preamble INTO the resource: an
		// unlabeled blob of other-agent turns is a mild injection surface.
		assert.ok(seen.opts.contextBlock.text.includes("context from the broader pi session"));
		assert.ok(seen.opts.contextBlock.text.includes("claude says hi"));
		// ...and stays out of the prompt text (no inline preamble).
		assert.equal(seen.opts.prompt, "current");
	} finally {
		delete process.env.AGY_ENGINE;
		delete process.env.AGY_DIGEST;
	}
});

test("streamSimple: stream-json engine keeps the digest inline in the prompt", async () => {
	process.env.AGY_ENGINE = "stream-json";
	process.env.AGY_DIGEST = "1";
	try {
		// Two distinct drivers: production wiring never shares one instance
		// between the driver and acpDriver roles, and the engine heuristic
		// keys off object identity.
		const seen: { opts?: DriverTurnRequest } = {};
		const streamSeen: { opts?: DriverTurnRequest } = {};
		const streamDriver = capturingDriver(streamSeen);
		const acpSeen: { opts?: DriverTurnRequest } = {};
		const acpOnlyDriver = capturingDriver(acpSeen);
		const streamSimple = createStreamSimple({
			entries: [{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] }],
			store: new SessionStore(tmpStorePath()),
			driver: streamDriver,
			acpDriver: acpOnlyDriver,
			roundTrips: new ToolRoundTrips(streamDriver),
		});
		const stream = streamSimple(
			{ ...model, id: "gemini-flash" },
			digestContext(),
			{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
		);
		for await (const ev of stream) void ev;
		assert.match(streamSeen.opts?.prompt ?? "", /context from the broader pi session/);
		assert.match(streamSeen.opts?.prompt ?? "", /claude says hi/);
		assert.equal(streamSeen.opts?.contextBlock, undefined);
		assert.equal(acpSeen.opts, undefined, "acp driver must not run");
	} finally {
		delete process.env.AGY_ENGINE;
		delete process.env.AGY_DIGEST;
	}
});

test("streamSimple forwards options.reasoning as effort for an effort-driven base", async () => {
	const opts = await captureTurn(
		{ full: "gemini-3.6-flash", id: "gemini-flash", efforts: ["low", "medium", "high"] },
		"high",
	);
	assert.equal(opts?.model, "gemini-3.6-flash");
	assert.equal(opts?.effort, "high");
});

test("streamSimple clamps an unsupported tier to the base's nearest effort", async () => {
	const opts = await captureTurn(
		{ full: "gemini-3.1-pro", id: "pro", efforts: ["low", "high"] },
		// medium is not valid for Pro (hidden in the toggle); provider clamps to high.
		"medium",
	);
	assert.equal(opts?.model, "gemini-3.1-pro");
	assert.equal(opts?.effort, "high");
});

test("streamSimple omits effort for a fixed (non-effort) model", async () => {
	const opts = await captureTurn({ full: "claude-sonnet-4-6", id: "claude-sonnet" }, "high");
	assert.equal(opts?.model, "claude-sonnet-4-6");
	assert.equal(opts?.effort, undefined);
});

test("Gate C: consumeActivity parks for native-tools on stream-json engine", () => {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "agy-bridge" as Api,
		provider: "antigravity",
		model: "gemini-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const blocks = { partial, textIdx: null, thinkingIdx: null, started: false };
	const diffCtx = new TurnDiffContext({ toplevel: () => null, showHead: () => null });
	const driver = capturingDriver({});
	const roundTrips = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();

	const res = consumeActivity(
		stream,
		blocks,
		{ type: "tool_done", name: "view_file", args: { path: "/test.ts" } },
		diffCtx,
		process.cwd(),
		{ replay, roundTrips, nativeActive: () => true, engine: "stream-json" },
	);
	assert.equal(res, "parked");
	assert.equal(partial.stopReason, "toolUse");
});

test("Gate C: consumeActivity skips native re-exec and wrapper replay on ACP engine", () => {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "agy-bridge" as Api,
		provider: "antigravity",
		model: "gemini-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const blocks = { partial, textIdx: null, thinkingIdx: null, started: false };
	const diffCtx = new TurnDiffContext({ toplevel: () => null, showHead: () => null });
	const driver = capturingDriver({});
	const roundTrips = new ToolRoundTrips(driver);
	const replay = new WrapperReplay();

	const res = consumeActivity(
		stream,
		blocks,
		{ type: "tool_done", name: "view_file", args: { path: "/test.ts" } },
		diffCtx,
		process.cwd(),
		{ replay, roundTrips, nativeActive: () => true, engine: "acp" },
	);
	assert.equal(res, "continue");
	assert.equal(partial.stopReason, "stop");
	assert.ok(partial.content.some((b) => b.type === "thinking" && b.thinking.includes("[agy tool: view_file]")));
});

test("streamSimple invokes options.onResponse with provider and quota headers", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const store = new SessionStore(tmpStorePath());
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});

	setCachedQuotaReport({
		groups: [
			{
				name: "Gemini",
				buckets: [
					{ name: "5h window", window: "5h", remainingFraction: 0.85, resetTime: "2026-10-31T05:00:00Z" },
				],
			},
		],
	});

	let responseReceived: { status?: number; headers?: Record<string, string> } | undefined;
	const stream = streamSimple(
		{ ...model, id: "gemini-flash" },
		contextWith("test prompt"),
		{
			cwd: process.cwd(),
			onResponse: (res: { status?: number; headers?: Record<string, string> }) => {
				responseReceived = res;
			},
		} as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;

	assert.ok(responseReceived);
	assert.equal(responseReceived.status, 200);
	assert.equal(responseReceived.headers?.["x-provider"], "antigravity");
	assert.equal(responseReceived.headers?.["x-antigravity-model"], "gemini-3.6-flash");
	assert.equal(responseReceived.headers?.["x-antigravity-quota-5h"], "85");
	assert.equal(responseReceived.headers?.["x-ratelimit-remaining"], "85");
	setCachedQuotaReport(undefined);
});

test("streamSimple isolates ephemeral turns with cacheRetention: 'none'", async () => {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = capturingDriver(seen);
	const storePath = tmpStorePath();
	const store = new SessionStore(storePath);

	const cwd = process.cwd();
	store.set(`cwd:${cwd}`, {
		conversationId: "conv-existing-123",
		lastStepIdx: 5,
		lastMessageCount: 2,
		modelId: "gemini-3.6-flash",
	});

	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});

	const stream = streamSimple(
		{ ...model, id: "gemini-flash" },
		contextWith("summarize session"),
		{
			cwd,
			cacheRetention: "none",
		} as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;

	// Must NOT reuse the existing conversation ID
	assert.equal(seen.opts?.conversationId, null);

	// Must NOT overwrite or delete the existing conversation binding in store
	const storedAfter = store.get(`cwd:${cwd}`);
	assert.ok(storedAfter);
	assert.equal(storedAfter.conversationId, "conv-existing-123");
	assert.equal(storedAfter.lastMessageCount, 2);
});

// --- T3 (S3): inflated token/context usage + /compact continuity -------------
//
// Live agy reports cumulative multi-turn/multi-step billing totals (2.44M,
// 34M) against a 1M context window, and pi derives context occupancy, its
// compaction checks and "Compacted from X tokens" from usage.totalTokens. A
// spike that clears the window while the transcript is nowhere near it is
// billing metadata, not occupancy: it must never reach the assistant message.
// After /compact the binding rotates to a fresh conversation, so the pi-side
// summary + kept post-cut turns have to ship once even with digest off.

/** Assistant message shell for consumeActivity tests (zero usage). */
function usageBlocks(): BlockState {
	return {
		partial: {
			role: "assistant",
			content: [],
			api: "agy-bridge" as Api,
			provider: "antigravity",
			model: "gemini-flash",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
		textIdx: null,
		thinkingIdx: null,
		started: false,
	};
}

const VALID_STEP_USAGE = {
	input_tokens: 2_206,
	output_tokens: 28,
	cache_read_tokens: 14_007,
	total_tokens: 2_234,
};

test("consumeActivity: a cumulative usage spike over the context window is discarded, the last valid step survives", () => {
	const stream = createAssistantMessageEventStream();
	const blocks = usageBlocks();
	const logs: Array<[string, unknown, string?]> = [];
	const feats = {
		contextWindow: 1_000_000,
		contextInputTokens: 15_000,
		log: (event: string, data: unknown, level?: string) => logs.push([event, data, level]),
	};
	const diffCtx = new TurnDiffContext({ toplevel: () => null, showHead: () => null });

	assert.equal(
		consumeActivity(stream, blocks, { type: "usage", usage: VALID_STEP_USAGE }, diffCtx, process.cwd(), feats),
		"continue",
	);
	// Uncached input + cached prefix + output: the real occupancy of the step.
	assert.equal(blocks.partial.usage.input, 2_206);
	assert.equal(blocks.partial.usage.cacheRead, 14_007);
	assert.equal(blocks.partial.usage.totalTokens, 16_241);

	for (const spike of [2_440_363, 34_000_000]) {
		assert.equal(
			consumeActivity(
				stream,
				blocks,
				{ type: "usage", usage: { input_tokens: spike, output_tokens: 40, total_tokens: spike + 40 } },
				diffCtx,
				process.cwd(),
				feats,
			),
			"continue",
		);
		// Discarded whole: neither the spike nor a latched peak lands.
		assert.equal(blocks.partial.usage.input, 2_206);
		assert.equal(blocks.partial.usage.cacheRead, 14_007);
		assert.equal(blocks.partial.usage.totalTokens, 16_241);
	}
	assert.deepEqual(
		logs.map(([event, data]) => [event, (data as { reportedTotal?: number }).reportedTotal]),
		[
			["usage-clamped", 2_440_403],
			["usage-clamped", 34_000_040],
		],
	);
});

/** Fake driver that replays scripted activities, then settles OK bound to
 *  `conversationId`. Records the turn request the provider handed over. */
function scriptedDriver(
	activities: DriverActivity[],
	seen: { opts?: DriverTurnRequest },
	conversationId = "conv-scripted",
): StreamDriver {
	return {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			const queue = [...activities];
			return {
				id: "scripted-turn",
				outcome: Promise.resolve({
					status: "OK" as const,
					response: "ok",
					finished: true,
					aborted: false,
					conversationId,
				}),
				next: async () => queue.shift() ?? null,
				pushExternal: () => {},
			};
		},
	} as unknown as StreamDriver;
}

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(values)) {
		prev[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return fn().finally(() => {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

test("streamSimple: cumulative multi-million usage spikes never reach the turn's reported usage", async () => {
	await withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined }, async () => {
		const seen: { opts?: DriverTurnRequest } = {};
		const driver = scriptedDriver(
			[
				{ type: "usage", usage: VALID_STEP_USAGE },
				{ type: "usage", usage: { input_tokens: 2_440_363, output_tokens: 40, total_tokens: 2_440_403 } },
				{ type: "usage", usage: { input_tokens: 34_000_000, output_tokens: 40, total_tokens: 34_000_040 } },
			],
			seen,
		);
		const streamSimple = createStreamSimple({
			entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
			store: new SessionStore(tmpStorePath()),
			driver,
			roundTrips: new ToolRoundTrips(driver),
		});
		let final: AssistantMessage | undefined;
		const stream = streamSimple(
			{ ...model, id: "gemini-flash" },
			contextWith("hi"),
			{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
		);
		for await (const ev of stream) {
			if (ev.type === "done") final = ev.message;
		}
		assert.ok(final, "the turn must settle with a done event");
		// Occupancy stays the valid step's, far below the 1M window: pi's
		// context %, overflow check and "Compacted from N tokens" read this.
		assert.equal(final.usage.input, 2_206);
		assert.equal(final.usage.cacheRead, 14_007);
		assert.equal(final.usage.output, 28);
		assert.equal(final.usage.totalTokens, 16_241);
		assert.ok(
			final.usage.totalTokens <= model.contextWindow,
			`reported total ${final.usage.totalTokens} must fit the ${model.contextWindow} window`,
		);
	});
});

/** Deterministic stamp derived from a text: the digest boundary fingerprint
 *  is `role:timestamp`, so replayed transcripts must keep stable stamps or
 *  every turn looks like a /tree rewrite (watermark reset to 0). */
function stamp(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
	return 1_700_000_000_000 + Math.abs(h);
}

function userMessage(content: string, timestamp: number = stamp(content)) {
	return { role: "user" as const, content, timestamp };
}

function assistantMessage(provider: string, text: string, timestamp: number = stamp(`${provider}:${text}`)) {
	return {
		role: "assistant" as const,
		provider,
		content: [{ type: "text" as const, text }],
		timestamp,
		model: "some-model",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		api: "agy-bridge" as Api,
	};
}

function compactionMessage(summary: string, timestamp: number = stamp(`summary:${summary}`)) {
	return {
		role: "user" as const,
		content: `The conversation history has been compacted into the following summary:\n<summary>\n${summary}\n</summary>`,
		timestamp,
	};
}

/** A parked round-trip's pi toolResult message (stable timestamp: the digest
 *  boundary fingerprint is role:timestamp). */
function toolResultMessage(callId: string, text: string, timestamp: number = stamp(`toolResult:${callId}`)) {
	return {
		role: "toolResult" as const,
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text" as const, text }],
		isError: false as const,
		timestamp,
	};
}

type TurnMessage =
	| ReturnType<typeof userMessage>
	| ReturnType<typeof assistantMessage>
	| ReturnType<typeof compactionMessage>
	| ReturnType<typeof toolResultMessage>;

/** pi context after a compaction: the summary, then turns kept after the cut,
 *  then the current prompt. Timestamps are index-stable: turn 2 rebuilds the
 *  same transcript with a different current prompt, and the digest boundary
 *  fingerprint must not move because of that. */
function compactedContext(currentPrompt: string): TranscriptContext {
	const at = (i: number) => 1_690_000_000_000 + i;
	return normalizeContext({
		systemPrompt: undefined,
		messages: [
			userMessage("m1", at(0)),
			assistantMessage("claude", "claude says hi", at(1)),
			userMessage("m2", at(2)),
			assistantMessage("antigravity", "pre-cut agy answer", at(3)),
			compactionMessage("sqlite was chosen", at(4)),
			userMessage("kept post-cut question", at(5)),
			assistantMessage("antigravity", "agy post-cut answer", at(6)),
			userMessage(currentPrompt, at(7)),
		],
	});
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test("sessionCompacted rotation ships the compaction summary + kept post-cut turns once, with digest off", async () => {
	// AGY_DIGEST=0 pins the config knob OFF: the forced compaction delivery must
	// survive an explicit digest opt-out (the rotated conversation has nothing).
	await withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: "0" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-compact-rot-"));
		const store = new SessionStore(path.join(dir, "sessions.json"));
		// A long conversation bound to agy, then pi compacts it down to 8.
		store.set(`cwd:${dir}`, {
			conversationId: "conv-long",
			lastStepIdx: -1,
			lastMessageCount: 12,
			modelId: "gemini-3.6-flash",
		});
		const seen: { opts?: DriverTurnRequest } = {};
		const driver = scriptedDriver([], seen, "conv-fresh");
		const streamSimple = createStreamSimple({
			entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
			store,
			driver,
			roundTrips: new ToolRoundTrips(driver),
		});
		try {
			const turn1 = streamSimple(
				{ ...model, id: "gemini-flash" },
				compactedContext("current question"),
				{ cwd: dir } as unknown as SimpleStreamOptions,
			);
			for await (const ev of turn1) void ev;

			// The rotation starts a fresh agy conversation: nothing it needs is
			// in agy's own history, so the pi-side context ships even though
			// config.digest is off.
			assert.equal(seen.opts?.conversationId, null, "compaction rotates the conversation");
			const prompt = seen.opts?.prompt ?? "";
			assert.equal(countOccurrences(prompt, "[pi compaction summary]"), 1);
			assert.ok(prompt.includes("sqlite was chosen"), "the summary body ships");
			assert.ok(prompt.includes("kept post-cut question"), "kept post-cut user turn ships");
			assert.ok(prompt.includes("agy post-cut answer"), "kept post-cut own turn ships (fresh conversation)");
			assert.ok(!prompt.includes("pre-cut agy answer"), "pre-cut detail stays out");
			assert.ok(prompt.endsWith("current question"));

			// The next turn resumes the fresh conversation: no rotation, digest
			// off, so nothing is re-injected.
			seen.opts = undefined;
			const turn2 = streamSimple(
				{ ...model, id: "gemini-flash" },
				compactedContext("second question"),
				{ cwd: dir } as unknown as SimpleStreamOptions,
			);
			for await (const ev of turn2) void ev;
			const second = seen.opts as DriverTurnRequest | undefined;
			assert.equal(second?.conversationId, "conv-fresh");
			const prompt2 = second?.prompt ?? "";
			assert.equal(countOccurrences(prompt2, "[pi compaction summary]"), 0);
			assert.equal(prompt2, "second question");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Provider wired to a scripted driver bound to `conversationId`, plus a
 *  `turn()` helper that runs one transcript and returns the captured request. */
function digestHarness(
	dir: string,
	entries: { full: string; id: string }[],
	conversationId = "conv-agy",
) {
	const store = new SessionStore(path.join(dir, "sessions.json"));
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = scriptedDriver([], seen, conversationId);
	const streamSimple = createStreamSimple({
		entries,
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const turn = async (
		messages: TurnMessage[],
		modelId = "gemini-flash",
	): Promise<DriverTurnRequest | undefined> => {
		seen.opts = undefined;
		const stream = streamSimple(
			{ ...model, id: modelId },
			normalizeContext({ systemPrompt: undefined, messages }),
			{ cwd: dir } as unknown as SimpleStreamOptions,
		);
		for await (const ev of stream) void ev;
		return seen.opts;
	};
	return { store, seen, turn };
}

/** Isolated HOME for the duration of `run`: loadConfig() resolves the default
 *  config path from $HOME, and the developer's real config could carry an
 *  explicit `digest: false` that masks the default-on behavior under test. */
async function withIsolatedHome(run: () => Promise<void>): Promise<void> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
	const prev = process.env.HOME;
	process.env.HOME = home;
	try {
		await run();
	} finally {
		if (prev === undefined) delete process.env.HOME;
		else process.env.HOME = prev;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("digest default on: a model-switch handoff ships pi-side context to the fresh conversation", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-"));
		try {
			const h = digestHarness(
				dir,
				[
					{ full: "gemini-3.6-flash", id: "gemini-flash" },
					{ full: "claude-sonnet-4-6", id: "claude-sonnet" },
				],
				"conv-claude",
			);
			// The session was bound to the previous model; switching models rotates
			// to a conversation that has seen nothing at all.
			h.store.set(`cwd:${dir}`, {
				conversationId: "conv-gemini",
				lastStepIdx: -1,
				lastMessageCount: 1,
				modelId: "gemini-3.6-flash",
			});
			const opts = await h.turn(
				[
					userMessage("earlier question"),
					assistantMessage("antigravity", "agy earlier answer"),
					assistantMessage("claude", "claude says hi"),
					userMessage("current question"),
				],
				"claude-sonnet",
			);
			assert.equal(opts?.conversationId, null, "the model switch starts a fresh conversation");
			const prompt = opts?.prompt ?? "";
			assert.ok(prompt.includes("[earlier user message]"), "digest ships with AGY_DIGEST unset (default on)");
			assert.ok(prompt.includes("agy earlier answer"), "fresh conversation receives agy's own prior turns too");
			assert.ok(prompt.includes("claude says hi"));
			assert.ok(prompt.endsWith("current question"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

test("a transcript mutated under the watermark resets the digest to the full delta", async () => {
	await withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-boundary-"));
		try {
			const h = digestHarness(dir, [{ full: "gemini-3.6-flash", id: "gemini-flash" }]);
			const first = await h.turn([userMessage("original opener")]);
			assert.equal(first?.prompt, "original opener");
			// /tree or /fork rewrote the message the stored watermark points at: the
			// old count would skip everything the rewritten branch holds.
			const forked = await h.turn([
				userMessage("rewritten opener", stamp("original opener") + 1),
				assistantMessage("claude", "claude says hi"),
				userMessage("second question"),
			]);
			assert.equal(forked?.conversationId, "conv-agy", "the bound conversation is resumed");
			const prompt = forked?.prompt ?? "";
			assert.ok(prompt.includes("rewritten opener"), "the rewritten branch ships in the delta");
			assert.ok(prompt.includes("claude says hi"));
			assert.ok(prompt.endsWith("second question"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

	test("digest steady state: pure-agy turns ship nothing, a delivered summary never repeats, a new summary ships once", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-digest-steady-"));
		try {
			const h = digestHarness(dir, [{ full: "gemini-3.6-flash", id: "gemini-flash" }]);
			const key = `cwd:${dir}`;

			// Turn 1: fresh conversation, nothing pi-side to carry.
			assert.equal((await h.turn([userMessage("q1")]))?.prompt, "q1");

			// Turn 2: the only new pi-side message is agy's own turn, already in
			// its DB, so a pure-agy steady state stays byte-stable.
			const t2 = await h.turn([
				userMessage("q1"),
				assistantMessage("antigravity", "a1"),
				userMessage("q2"),
			]);
			assert.equal(t2?.prompt, "q2");
			assert.equal(t2?.contextBlock, undefined, "stream-json never uses a context block");

			// Turn 3: pi compacts. The summary has never been in agy's DB, so it
			// ships (with the kept post-cut turns), and its identity settles.
			const compacted: TurnMessage[] = [
				compactionMessage("sqlite was chosen"),
				userMessage("kept question"),
				assistantMessage("antigravity", "kept answer"),
				userMessage("q3"),
			];
			const t3 = await h.turn(compacted);
			const prompt3 = t3?.prompt ?? "";
			assert.equal(countOccurrences(prompt3, "[pi compaction summary]"), 1);
			assert.ok(prompt3.includes("sqlite was chosen"));
			assert.ok(prompt3.endsWith("q3"));
			const summary1 = h.store.get(key)?.digestSummaryId;
			assert.ok(summary1, "the delivered summary identity settles into the session record");

			// Turn 4: bound steady state. The SAME summary is still in the
			// transcript; re-injecting it would defeat the prompt cache.
			const t4 = await h.turn([...compacted, assistantMessage("antigravity", "a3"), userMessage("q4")]);
			assert.equal(t4?.prompt, "q4");

			// Turn 5: a second compaction puts a NEW summary at index 0 (pi rebuilds
			// post-compaction transcripts this way). Index identity would swallow
			// it; content identity ships it exactly once.
			const recompacted: TurnMessage[] = [
				compactionMessage("postgres was chosen"),
				userMessage("kept question"),
				assistantMessage("antigravity", "kept answer"),
				userMessage("q4"),
				assistantMessage("antigravity", "a4"),
				userMessage("q5"),
			];
			const t5 = await h.turn(recompacted);
			const prompt5 = t5?.prompt ?? "";
			assert.equal(countOccurrences(prompt5, "[pi compaction summary]"), 1);
			assert.ok(prompt5.includes("postgres was chosen"));
			assert.ok(!prompt5.includes("sqlite was chosen"), "the superseded summary is not replayed");
			assert.ok(prompt5.endsWith("q5"));
			const summary2 = h.store.get(key)?.digestSummaryId;
			assert.ok(summary2 && summary2 !== summary1, "a new summary replaces the recorded identity");

			// Turn 6: the new summary is delivered, so the next bound turn is bare.
			const t6 = await h.turn([...recompacted, assistantMessage("antigravity", "a5"), userMessage("q6")]);
			assert.equal(t6?.prompt, "q6");
			assert.equal(h.store.get(key)?.digestSummaryId, summary2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

test("legacy record without digestBoundary keeps its watermark (no duplicate dump) and settle fills it", async () => {
	await withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: "1", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-boundary-legacy-"));
		try {
			const h = digestHarness(dir, [{ full: "gemini-3.6-flash", id: "gemini-flash" }]);
			const key = `cwd:${dir}`;
			// A record written before digestBoundary existed. Its count is trusted
			// as-is: resetting would dump the whole history once on upgrade.
			h.store.set(key, {
				conversationId: "conv-agy",
				lastStepIdx: -1,
				lastMessageCount: 2,
				modelId: "gemini-3.6-flash",
			});
			const opts = await h.turn([
				userMessage("m1"),
				assistantMessage("antigravity", "a1"),
				userMessage("m2"),
			]);
			assert.equal(opts?.prompt, "m2", "legacy record trusted: no full-history dump");
			const rec = h.store.get(key);
			assert.equal(rec?.digestBoundary, `user:${stamp("m2")}`, "settle records the boundary it saw");
			assert.equal(rec?.lastMessageCount, 3);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("stream-json budgets the prompt and the digest in UTF-8 bytes, not characters", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-byte-budget-"));
		try {
			const h = digestHarness(dir, [{ full: "gemini-3.6-flash", id: "gemini-flash" }]);
			const cjk = (n: number) => "漢".repeat(n);

			// (a) The prompt alone exhausts the byte budget: 8k CJK chars are ~24KB
			// although the character count looks harmless.
			const bigPrompt = cjk(8_000);
			const a = await h.turn([
				userMessage("earlier context"),
				assistantMessage("claude", "claude says hi"),
				userMessage(bigPrompt),
			]);
			assert.equal(a?.prompt, bigPrompt, "digest skipped when the prompt's UTF-8 bytes exhaust the cap");

			// (b) The DIGEST is multibyte: it fits the 8000-char cap but overflows
			// the remaining byte budget, so stream-json must skip it (agy silently
			// drops an over-cap prompt).
			const b = await h.turn([
				userMessage("tiny"),
				assistantMessage("claude", cjk(8_000)),
				userMessage("current"),
			]);
			assert.equal(b?.prompt, "current", "digest skipped when its UTF-8 bytes overflow the cap");

			// (c) A multibyte digest that fits the byte budget still ships.
			const c = await h.turn([
				userMessage("tiny"),
				assistantMessage("claude", cjk(2_000)),
				userMessage("final"),
			]);
			const prompt = c?.prompt ?? "";
			assert.ok(prompt.includes("context from the broader pi session"), "under-budget multibyte digest ships");
			assert.ok(prompt.includes("漢"));
			assert.ok(prompt.endsWith("final"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

test("ephemeral turn (cacheRetention 'none') never opens the pi system-prompt gate", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ephemeral-agents-"));
	await withEnv(
		{ AGY_ENGINE: "stream-json", AGY_SYSTEM_PROMPT: "on", AGY_AGENT: undefined, AGY_AGENTS_ROOT: root },
		async () => {
			resetSyspromptAgentForTests();
			const seen: { opts?: DriverTurnRequest } = {};
			const driver = capturingDriver(seen);
			const streamSimple = createStreamSimple({
				entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
				store: new SessionStore(tmpStorePath()),
				driver,
				roundTrips: new ToolRoundTrips(driver),
			});
			try {
				const context = normalizeContext({
					systemPrompt: "You are pi. Follow AGENTS.md.",
					messages: [{ role: "user", content: "summarize this session", timestamp: Date.now() }],
				});
				const stream = streamSimple(
					{ ...model, id: "gemini-flash" },
					context,
					{ cwd: process.cwd(), cacheRetention: "none" } as unknown as SimpleStreamOptions,
				);
				for await (const ev of stream) void ev;
				// Nothing pi-side rides a throwaway summarization turn: no carrier
				// agent staged, no prompt framing.
				assert.equal(seen.opts?.agent, undefined, "no carrier agent for an ephemeral turn");
				const prompt = seen.opts?.prompt ?? "";
				assert.equal(prompt, "summarize this session");
				assert.ok(!prompt.includes(SYSTEM_PROMPT_PREAMBLE));
				assert.ok(!prompt.includes(TOOL_PRIORITY_NOTE));
				assert.deepEqual(fs.readdirSync(root), [], "nothing staged into the agents root");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

test("preserve: a non-ephemeral fresh turn still ships the pi system prompt framing", async () => {
	await withEnv(
		{ AGY_ENGINE: "acp", AGY_SYSTEM_PROMPT: "on", AGY_AGENT: undefined },
		async () => {
			resetSyspromptAgentForTests();
			const streamDriver = capturingDriver({});
			const seen: { opts?: DriverTurnRequest } = {};
			const acpDriver = capturingDriver(seen);
			const streamSimple = createStreamSimple({
				entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
				store: new SessionStore(tmpStorePath()),
				driver: streamDriver,
				acpDriver,
				roundTrips: new ToolRoundTrips(streamDriver),
			});
			const context = normalizeContext({
				systemPrompt: "You are pi. Follow AGENTS.md.",
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			});
			const stream = streamSimple(
				{ ...model, id: "gemini-flash" },
				context,
				{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
			);
			for await (const ev of stream) void ev;
			const prompt = seen.opts?.prompt ?? "";
			assert.ok(prompt.startsWith(SYSTEM_PROMPT_PREAMBLE));
			assert.ok(prompt.includes("You are pi. Follow AGENTS.md."));
			assert.ok(prompt.includes(TOOL_PRIORITY_NOTE));
		},
	);
});

// --- S4: a byte-budget skip must not consume the pending delta -------------
//
// Judgment Day round 1 (I1 = A1/B1/B2): a turn whose digest is skipped for
// byte budget still settled lastMessageCount/digestBoundary, so the skipped
// delta started after the advanced watermark and was never delivered in that
// bound conversation. The skip must keep the PREVIOUS watermark and boundary
// (watermark 0 when no trusted prior watermark existed) so a later, smaller
// turn re-delivers the handoff, while the binding and digestSummaryId persist.

test("a byte-budget-skipped digest keeps the previous watermark, so a smaller turn re-delivers the delta", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-keep-"));
		try {
			const h = digestHarness(dir, [{ full: "gemini-3.6-flash", id: "gemini-flash" }]);
			const key = `cwd:${dir}`;
			h.store.set(key, {
				conversationId: "conv-agy",
				lastStepIdx: -1,
				lastMessageCount: 2,
				modelId: "gemini-3.6-flash",
				digestBoundary: `user:${stamp("m2")}`,
			});
			// Pending delta (the claude turn) whose UTF-8 bytes cannot fit the
		// remaining budget: an over-cap prompt is silently dropped by agy, so
		// the digest must be skipped WITHOUT consuming the pending delta.
			const skipped = await h.turn([
				userMessage("m1"),
				userMessage("m2"),
				assistantMessage("claude", "漢".repeat(8_000)),
				userMessage("current"),
			]);
			assert.equal(skipped?.conversationId, "conv-agy", "the conversation binding persists");
			assert.equal(skipped?.prompt, "current", "nothing ships: the digest is skipped");
			const rec = h.store.get(key);
			assert.equal(rec?.lastMessageCount, 2, "the previous watermark is kept");
			assert.equal(rec?.digestBoundary, `user:${stamp("m2")}`, "the previous boundary is kept");

			// A later smaller turn (same last message, so the kept watermark
			// validates) delivers the held handoff and settles normally.
			const smaller = await h.turn([
				userMessage("m1"),
				userMessage("m2"),
				assistantMessage("claude", "smaller note"),
				userMessage("current", stamp("current")),
			]);
			assert.equal(smaller?.conversationId, "conv-agy", "still bound to the same conversation");
			assert.equal(countOccurrences(smaller?.prompt ?? "", "smaller note"), 1, "the pending delta is delivered on the smaller turn");
			assert.ok((smaller?.prompt ?? "").includes("context from the broader pi session"));
			const rec2 = h.store.get(key);
			assert.equal(rec2?.lastMessageCount, 4, "a delivered digest advances the watermark");
			assert.equal(rec2?.digestBoundary, `user:${stamp("current")}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

test("a prompt that alone exhausts the byte budget skips the digest without consuming the delta", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-prompt-"));
		try {
			const h = digestHarness(dir, [{ full: "gemini-3.6-flash", id: "gemini-flash" }]);
			const key = `cwd:${dir}`;
			h.store.set(key, {
				conversationId: "conv-agy",
				lastStepIdx: -1,
				lastMessageCount: 2,
				modelId: "gemini-3.6-flash",
				digestBoundary: `user:${stamp("m2")}`,
			});
			// 8k CJK chars are ~24KB: the prompt alone exhausts the budget
			// (digestMaxCharsForEngine returns null at the build site).
			const bigPrompt = "漢".repeat(8_000);
			const skipped = await h.turn([
				userMessage("m1"),
				userMessage("m2"),
				assistantMessage("claude", "context note"),
				userMessage(bigPrompt),
			]);
			assert.equal(skipped?.prompt, bigPrompt, "the prompt ships, the digest does not");
			const rec = h.store.get(key);
			assert.equal(rec?.lastMessageCount, 2, "the previous watermark is kept");
			assert.equal(rec?.digestBoundary, `user:${stamp("m2")}`, "the previous boundary is kept");

			const smaller = await h.turn([
				userMessage("m1"),
				userMessage("m2"),
				assistantMessage("claude", "smaller note"),
				userMessage("current"),
			]);
			assert.equal(countOccurrences(smaller?.prompt ?? "", "smaller note"), 1, "the pending delta is delivered on the smaller turn");
			const rec2 = h.store.get(key);
			assert.equal(rec2?.lastMessageCount, 4);
			assert.equal(rec2?.digestBoundary, `user:${stamp("current")}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

test("an over-tight cap that squeezes the builder to nothing still keeps the delta pending", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-squeeze-"));
		try {
			const h = digestHarness(dir, [{ full: "gemini-3.6-flash", id: "gemini-flash" }]);
			const key = `cwd:${dir}`;
			h.store.set(key, {
				conversationId: "conv-agy",
				lastStepIdx: -1,
				lastMessageCount: 2,
				modelId: "gemini-3.6-flash",
				digestBoundary: `user:${stamp("m2")}`,
			});
			// CAP - MARGIN - 12: maxChars lands at 12, below the floor the
			// truncation marker needs, so the builder returns "" while the
			// delta part is pending. That shape is still a byte-budget skip.
			const tightPrompt = "x".repeat(STREAM_JSON_PROMPT_CAP - STREAM_JSON_PROMPT_MARGIN - 12);
			const skipped = await h.turn([
				userMessage("m1"),
				userMessage("m2"),
				assistantMessage("claude", "claude says hi"),
				userMessage(tightPrompt),
			]);
			assert.equal(skipped?.prompt, tightPrompt);
			const rec = h.store.get(key);
			assert.equal(rec?.lastMessageCount, 2, "the previous watermark is kept");
			assert.equal(rec?.digestBoundary, `user:${stamp("m2")}`, "the previous boundary is kept");

			const smaller = await h.turn([
				userMessage("m1"),
				userMessage("m2"),
				assistantMessage("claude", "smaller note"),
				userMessage("current"),
			]);
			assert.equal(countOccurrences(smaller?.prompt ?? "", "smaller note"), 1, "the pending delta is delivered on the smaller turn");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

test("a byte-budget-skipped compaction rotation keeps the handoff pending, so the retry delivers the kept post-cut turns", async () => {
	// AGY_DIGEST=0: the forced compaction delivery (and its pending S4 retry)
	// must fire even with the digest knob off.
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: "0", AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-rot-"));
		try {
			const h = digestHarness(dir, [{ full: "gemini-3.6-flash", id: "gemini-flash" }], "conv-fresh");
			const key = `cwd:${dir}`;
			// A long conversation bound to agy, then pi compacts it down to 8.
			h.store.set(key, {
				conversationId: "conv-long",
				lastStepIdx: -1,
				lastMessageCount: 12,
				modelId: "gemini-3.6-flash",
			});
			const at = (i: number) => 1_690_000_000_000 + i;
			// The KEPT own turn closest to the cut is oversized: the digest
			// truncator keeps the newest delta part (clamped), so the only way the
			// byte guard trips is when THAT part itself cannot fit the budget.
			const base: TurnMessage[] = [
				userMessage("m1", at(0)),
				assistantMessage("claude", "claude says hi", at(1)),
				userMessage("m2", at(2)),
				assistantMessage("antigravity", "pre-cut agy answer", at(3)),
				compactionMessage("sqlite was chosen", at(4)),
				userMessage("kept post-cut question", at(5)),
				assistantMessage("antigravity", "測".repeat(12_000) + "sentinel post-cut answer", at(6)),
			];
			const withPrompt = (current: string): TurnMessage[] => [...base, userMessage(current, at(7))];
			// The retry: a LATER SMALLER turn (the oversized kept turn aged out of
			// pi's transcript; the summary is still undelivered). Identical pending
			// bytes would re-trip the same byte budget, by design.
			const retryBase: TurnMessage[] = [
				...base.slice(0, 6),
				assistantMessage("antigravity", "sentinel post-cut answer", at(6)),
			];
			const withRetryPrompt = (current: string): TurnMessage[] => [...retryBase, userMessage(current, at(7))];

			// The rotation handoff cannot fit the byte budget alongside the
			// prompt: skipped, and the fresh conversation must not be marked as
			// having seen anything.
			const skipped = await h.turn(withPrompt("current question"));
			assert.equal(skipped?.conversationId, null, "compaction rotates the conversation");
			assert.ok(!(skipped?.prompt ?? "").includes("sqlite was chosen"), "the handoff is skipped, not shipped");
			const rec = h.store.get(key);
			assert.equal(rec?.lastMessageCount, 0, "no trusted prior watermark after the rotation: keep 0");
			assert.equal(rec?.digestBoundary, undefined);
			assert.equal(rec?.digestSummaryId, undefined, "the fresh conversation has seen no summary");

			// The retry turn runs the digest in rotation shape again: the summary
			// plus the kept post-cut turns (own turns included) still arrive.
			const retry = await h.turn(withRetryPrompt("retry question"));
			assert.equal(retry?.conversationId, "conv-fresh", "the retry resumes the rotated conversation");
			const retryPrompt = retry?.prompt ?? "";
			assert.equal(countOccurrences(retryPrompt, "[pi compaction summary]"), 1, "the summary ships exactly once");
			assert.ok(retryPrompt.includes("sqlite was chosen"));
			assert.ok(retryPrompt.includes("sentinel post-cut answer"), "kept post-cut own turn ships via the retry");
			assert.ok(retryPrompt.includes("kept post-cut question"), "the kept post-cut user turn ships via the retry");
			assert.ok(!retryPrompt.includes("pre-cut agy answer"), "pre-cut detail stays out");
			assert.ok(retryPrompt.endsWith("retry question"));
			const rec2 = h.store.get(key);
			assert.equal(rec2?.lastMessageCount, 8, "the delivered handoff advances the watermark");
			assert.equal(rec2?.digestBoundary, `user:${at(7)}`);
			assert.ok(rec2?.digestSummaryId, "the delivered summary identity settles");

			// The handoff is consumed: pure-agy steady state stays bare.
			const third = await h.turn([
				...withRetryPrompt("retry question"),
				assistantMessage("antigravity", "later answer", at(8)),
				userMessage("current3", at(9)),
			]);
			assert.equal(third?.prompt, "current3", "no re-injection after the retry delivered the handoff");
			assert.equal(countOccurrences(third?.prompt ?? "", "[pi compaction summary]"), 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

// --- S4 defect (round 2): a byte-budget skip of a NON-rotation fresh handoff
// (model switch, engine switch, recreation recovery — not a compactedRotation)
// must retry in FRESH shape: the retried conversation has seen none of agy's
// own prior turns, so own-provider assistant turns must ship on the retry, for
// as many retries as the handoff needs.

test("a byte-budget-skipped non-rotation fresh handoff retries in fresh shape (own-provider turns ship on the retry)", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-fresh-"));
		try {
			const h = digestHarness(
				dir,
				[
					{ full: "gemini-3.6-flash", id: "gemini-flash" },
					{ full: "claude-sonnet-4-6", id: "claude-sonnet" },
				],
				"conv-fresh",
			);
			const key = `cwd:${dir}`;
			const bigPrompt = "漢".repeat(8_000); // ~24KB: prompt alone exhausts the cap
			// Bound to the previous model; a model switch rotates to a fresh
			// conversation that is NOT a compaction rotation.
			h.store.set(key, {
				conversationId: "conv-gemini",
				lastStepIdx: -1,
				lastMessageCount: 1,
				modelId: "gemini-3.6-flash",
			});
			const skipped = await h.turn(
				[
					userMessage("m1"),
					assistantMessage("antigravity", "pre-switch agy answer"),
					userMessage(bigPrompt),
				],
				"claude-sonnet",
			);
			assert.equal(skipped?.conversationId, null, "the model switch starts a fresh conversation");
			assert.equal(skipped?.prompt, bigPrompt, "the handoff digest is skipped for byte budget");
			const rec = h.store.get(key);
			assert.equal(rec?.lastMessageCount, 0, "no trusted prior watermark: keep 0");
			assert.equal(rec?.digestBoundary, undefined);

			// A second skip (the retry prompt is ALSO oversized) on the SAME model
			// and conversation (R2-I1: without the modelId the model flip rotated
			// and re-seeded the marker through the unbound arm, so retryFresh
			// persistence across repeated skips was never exercised): the pending
			// fresh handoff must survive repeated skips.
			const skipped2 = await h.turn(
				[
					userMessage("m1"),
					assistantMessage("antigravity", "pre-switch agy answer"),
					userMessage(`second${bigPrompt}`),
				],
				"claude-sonnet",
			);
			assert.equal(skipped2?.prompt, `second${bigPrompt}`, "the digest is still skipped");

			// A smaller retry turn ships the held handoff in fresh shape: the
			// own-provider assistant turn from BEFORE the switch ships, because
			// the fresh conversation holds none of it.
			const retry = await h.turn([
				userMessage("m1"),
				assistantMessage("antigravity", "pre-switch agy answer"),
				userMessage("retry question"),
			], "claude-sonnet");
			assert.equal(retry?.conversationId, "conv-fresh", "the retry resumes the fresh conversation");
			const retryPrompt = retry?.prompt ?? "";
			assert.ok(retryPrompt.includes("pre-switch agy answer"), "own-provider turn ships on the retry");
			assert.ok(retryPrompt.includes("m1"), "the pending delta ships on the retry");
			assert.ok(retryPrompt.endsWith("retry question"));
			const rec2 = h.store.get(key);
			assert.equal(rec2?.lastMessageCount, 3, "the delivered handoff advances the watermark");
			assert.equal(rec2?.digestBoundary, `user:${stamp("retry question")}`);

			// The handoff shipped: pure-agy bound steady state no longer re-injects.
			const third = await h.turn([
				userMessage("m1"),
				assistantMessage("antigravity", "pre-switch agy answer"),
				userMessage("retry question"),
				assistantMessage("antigravity", "later answer"),
				userMessage("current3"),
			], "claude-sonnet");
			assert.equal(third?.prompt, "current3", "no re-injection after the retry delivered the handoff");
			assert.ok(!(third?.prompt ?? "").includes("pre-switch agy answer"), "bound steady state skips own turns again");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

// --- S4 round-3 corrections: the digestSkipPending lifecycle -------------
//
// Judgment Day round 2 (R2-S1/R2-S2/R2-S3, human-authorized extra round):
// "each piece ships once" must hold across the park path and gate-closed
// settles, not only the clean-OK shipping settle.

const CLAUDE_SWITCH_ENTRIES = [
	{ full: "gemini-3.6-flash", id: "gemini-flash" },
	{ full: "claude-sonnet-4-6", id: "claude-sonnet" },
];

/** R2-S1: a fresh-shape retry handoff that actually SHIPS on a turn which
 *  ends in a PARK must clear its pending marker there — the clean-OK settle
 *  never runs for a parked turn, and a surviving "fresh" marker re-ships the
 *  identical handoff into a conversation that already received it. */
test("a fresh-shape handoff that ships on a parked turn clears the pending marker (no duplicate handoff)", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-parkship-"));
		try {
			const requests: DriverTurnRequest[] = [];
			// The shipping turn parks: a bridge call is pushed onto its handle
			// before the pass starts; the continuation reenters the SAME live
			// handle; later passes settle OK on the same conversation.
			const parkedActivities: DriverActivity[] = [];
			const parkedHandle: TurnHandle = {
				id: "parked-turn",
				next: async () => parkedActivities.shift() ?? null,
				pushExternal: (activity: DriverActivity) => parkedActivities.push(activity),
				outcome: Promise.resolve({
					status: "OK" as const,
					response: "ok",
					finished: true,
					aborted: false,
					conversationId: "conv-park-fresh",
				}),
			};
			const settledHandle = (): TurnHandle => ({
				id: "settled-turn",
				next: async () => null,
				pushExternal: () => {},
				outcome: Promise.resolve({
					status: "OK" as const,
					response: "ok",
					finished: true,
					aborted: false,
					conversationId: "conv-park-fresh",
				}),
			});
			const driver = {
				get activeHandle() {
					return parkedHandle;
				},
				kickIdle: () => {},
				reentry: () => parkedHandle,
				snapshot: () => ({ conversationId: "conv-park-fresh" }),
				run: async (request: DriverTurnRequest) => {
					requests.push(request);
					return requests.length === 2 ? parkedHandle : settledHandle();
				},
			} as unknown as StreamDriver;
			const roundTrips = new ToolRoundTrips(driver, undefined, { escalateAfterMs: 0 });
			const store = new SessionStore(path.join(dir, "sessions.json"));
			const streamSimple = createStreamSimple({ entries: CLAUDE_SWITCH_ENTRIES, store, driver, roundTrips });
			const run = async (messages: TurnMessage[]) => {
				const stream = streamSimple(
					{ ...model, id: "claude-sonnet" },
					normalizeContext({ systemPrompt: undefined, messages }),
					{ cwd: dir } as unknown as SimpleStreamOptions,
				);
				for await (const ev of stream) void ev;
			};
			const key = `cwd:${dir}`;
			const bigPrompt = "漢".repeat(8_000); // ~24KB: prompt alone exhausts the cap
			// Bound to the previous model; a model switch rotates to a fresh
			// conversation whose fresh handoff is byte-skipped.
			store.set(key, {
				conversationId: "conv-gemini",
				lastStepIdx: -1,
				lastMessageCount: 1,
				modelId: "gemini-3.6-flash",
			});
			await run([userMessage("m1"), assistantMessage("antigravity", "pre-switch agy answer"), userMessage(bigPrompt)]);
			assert.equal(requests[0]?.conversationId, null, "the model switch starts a fresh conversation");
			assert.equal(requests[0]?.prompt, bigPrompt, "the handoff digest is skipped for byte budget");

			// The shipping turn: the pending fresh handoff SHIPS (own-provider
			// turns included) — and the turn parks on a bridge call.
			const parked = roundTrips.onToolCall("call-1", "read", {}, new AbortController().signal);
			await run([userMessage("m1"), assistantMessage("antigravity", "pre-switch agy answer"), userMessage("retry question")]);
			assert.ok(
				(requests[1]?.prompt ?? "").includes("pre-switch agy answer"),
				"the handoff actually ships on the parked turn",
			);
			assert.ok((requests[1]?.prompt ?? "").includes("retry question"));

			// The continuation settles the parked turn; no new agy turn starts.
			await run([
				userMessage("m1"),
				assistantMessage("antigravity", "pre-switch agy answer"),
				userMessage("retry question"),
				toolResultMessage("call-1", "tool output"),
			]);
			assert.equal(requests.length, 2, "the continuation reattaches without starting a new turn");
			await parked;
			const rec = store.get(key);
			assert.equal(rec?.lastMessageCount, 4, "the shipped handoff's window settles via the continuation");
			assert.equal(rec?.digestBoundary, `toolResult:${stamp("toolResult:call-1")}`);

			// The next turn must be bare: no duplicate handoff, no re-shipped
			// pre-switch own turn into a conversation that already received it.
			await run([
				userMessage("m1"),
				assistantMessage("antigravity", "pre-switch agy answer"),
				userMessage("retry question"),
				toolResultMessage("call-1", "tool output"),
				userMessage("next"),
			]);
			assert.equal(requests[2]?.prompt, "next", "no duplicate handoff after the parked turn shipped it");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

/** R2-S2 (config arm): a digest-off turn that closes the gate settles
 *  normally AND deliberately drops the pending handoff — no stale marker, no
 *  later stale or duplicated re-ship of the pre-switch own turns. */
test("a digest-off turn settles normally and drops a pending fresh handoff (no later stale re-ship)", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-offdrop-"));
		try {
			const h = digestHarness(dir, CLAUDE_SWITCH_ENTRIES, "conv-off-fresh");
			const key = `cwd:${dir}`;
			const bigPrompt = "漢".repeat(8_000);
			h.store.set(key, {
				conversationId: "conv-gemini",
				lastStepIdx: -1,
				lastMessageCount: 1,
				modelId: "gemini-3.6-flash",
			});
			const skipped = await h.turn(
				[userMessage("m1"), assistantMessage("antigravity", "pre-switch agy answer"), userMessage(bigPrompt)],
				"claude-sonnet",
			);
			assert.equal(skipped?.conversationId, null, "the model switch starts a fresh conversation");
			assert.equal(skipped?.prompt, bigPrompt, "the handoff digest is skipped for byte budget");

			// The user turns the digest OFF for the next turn.
			const prevDigest = process.env.AGY_DIGEST;
			let offTurn: DriverTurnRequest | undefined;
			try {
				process.env.AGY_DIGEST = "0";
				offTurn = await h.turn(
					[userMessage("m1"), assistantMessage("antigravity", "pre-switch agy answer"), userMessage("switched off")],
					"claude-sonnet",
				);
			} finally {
				if (prevDigest === undefined) delete process.env.AGY_DIGEST;
				else process.env.AGY_DIGEST = prevDigest;
			}
			assert.equal(offTurn?.prompt, "switched off", "a digest-off turn settles normally (bare prompt)");
			const rec = h.store.get(key);
			assert.equal(rec?.lastMessageCount, 3, "the digest-off turn settles the window");
			assert.equal(rec?.digestBoundary, `user:${stamp("switched off")}`);

			// A later digest-on turn must NOT re-ship the dropped handoff: the
			// config-off settle deliberately dropped it with the marker.
			const later = await h.turn(
				[
					userMessage("m1"),
					assistantMessage("antigravity", "pre-switch agy answer"),
					userMessage("switched off"),
					assistantMessage("antigravity", "agy answered while off"),
					userMessage("follow-up"),
				],
				"claude-sonnet",
			);
			assert.equal(later?.prompt, "follow-up", "no stale or duplicated handoff after the config-off drop");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

/** R2-S2 (transient arm): a late-result reattachment turn that closes the
 *  gate is a TRANSIENT suppression — the pending window is NOT consumed and
 *  the marker survives, so the handoff is retried later. */
test("a late-result turn that closes the digest gate keeps the pending window (handoff retried later)", async () => {
	await withIsolatedHome(() => withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "off" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-latehold-"));
		try {
			const requests: DriverTurnRequest[] = [];
			const handle = (): TurnHandle => ({
				id: "late-turn",
				next: async () => null,
				pushExternal: () => {},
				outcome: Promise.resolve({
					status: "OK" as const,
					response: "ok",
					finished: true,
					aborted: false,
					conversationId: "conv-late-fresh",
				}),
			});
			const driver = {
				get activeHandle() {
					return handle();
				},
				kickIdle: () => {},
				reentry: () => null,
				snapshot: () => ({ conversationId: "conv-late-fresh" }),
				run: async (request: DriverTurnRequest) => {
					requests.push(request);
					return handle();
				},
			} as unknown as StreamDriver;
			const roundTrips = new ToolRoundTrips(driver, undefined, { escalateAfterMs: 0 });
			const store = new SessionStore(path.join(dir, "sessions.json"));
			const streamSimple = createStreamSimple({ entries: CLAUDE_SWITCH_ENTRIES, store, driver, roundTrips });
			const run = async (messages: TurnMessage[]) => {
				const stream = streamSimple(
					{ ...model, id: "claude-sonnet" },
					normalizeContext({ systemPrompt: undefined, messages }),
					{ cwd: dir } as unknown as SimpleStreamOptions,
				);
				for await (const ev of stream) void ev;
			};
			const key = `cwd:${dir}`;
			const bigPrompt = "漢".repeat(8_000);
			store.set(key, {
				conversationId: "conv-gemini",
				lastStepIdx: -1,
				lastMessageCount: 1,
				modelId: "gemini-3.6-flash",
			});
			// Turn 1: the model switch rotates and the fresh handoff is skipped.
			await run([userMessage("m1"), assistantMessage("antigravity", "pre-switch agy answer"), userMessage(bigPrompt)]);
			assert.equal(requests[0]?.conversationId, null, "the model switch starts a fresh conversation");
			assert.equal(requests[0]?.prompt, bigPrompt, "the handoff digest is skipped for byte budget");

			// A dead park closes the digest gate for the late-result turn.
			const dead = roundTrips.onToolCall("call-9", "AskClaude", {}, new AbortController().signal);
			roundTrips.failAll("test expiry");
			await dead.catch(() => {});

			// Turn 2: the late-result reattachment turn (gate closed by the
			// transient late delivery) must NOT consume the pending window.
			await run([
				userMessage("m1"),
				assistantMessage("antigravity", "pre-switch agy answer"),
				toolResultMessage("call-9", "late output"),
			]);
			assert.match(requests[1]?.prompt ?? "", /Late tool delivery/);
			const rec = store.get(key);
			assert.equal(rec?.lastMessageCount, 0, "the pending window is NOT consumed by the late turn");
			assert.equal(rec?.digestBoundary, undefined, "the previous boundary is kept");

			// Turn 3: the handoff is retried later, in full fresh shape.
			await run([
				userMessage("m1"),
				assistantMessage("antigravity", "pre-switch agy answer"),
				toolResultMessage("call-9", "late output"),
				userMessage("next"),
			]);
			const retryPrompt = requests[2]?.prompt ?? "";
			assert.ok(retryPrompt.includes("pre-switch agy answer"), "the handoff is retried later");
			assert.ok(retryPrompt.includes("m1"), "the pending delta ships on the retry");
			assert.ok(retryPrompt.endsWith("next"));
			const rec2 = store.get(key);
			assert.equal(rec2?.lastMessageCount, 4, "the delivered handoff advances the watermark");

			// The handoff shipped: the next steady-state turn is bare.
			await run([
				userMessage("m1"),
				assistantMessage("antigravity", "pre-switch agy answer"),
				toolResultMessage("call-9", "late output"),
				userMessage("next"),
				userMessage("next2"),
			]);
			assert.equal(requests[3]?.prompt, "next2", "no re-injection after the retry delivered the handoff");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}));
});

// --- S4 (I2 = A2/B4): the byte budget must match the composed prompt -------
//
// The budget used to count only Buffer.byteLength(prompt); when the pi
// system-prompt block rides INLINE (a user-configured AGY_AGENT, or a
// stageSyspromptAgent failure falling back to the legacy inline block),
// prompt + digest could cross the ~25KB silent-drop cap while the guard
// reported within budget — and the whole prompt was then silently dropped.

/** Stream wrapper for the inline-system-prompt tests: builds the context
 *  itself so the pi system prompt can ride the transcript. */
function inlineSysHarness(dir: string) {
	const store = new SessionStore(path.join(dir, "sessions.json"));
	const seen: { opts?: DriverTurnRequest } = {};
	const driver = scriptedDriver([], seen, "conv-fresh");
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const run = async (
		systemPrompt: string | undefined,
		messages: TurnMessage[],
	): Promise<DriverTurnRequest | undefined> => {
		seen.opts = undefined;
		const stream = streamSimple(
			{ ...model, id: "gemini-flash" },
			normalizeContext({ systemPrompt, messages }),
			{ cwd: dir } as unknown as SimpleStreamOptions,
		);
		for await (const ev of stream) void ev;
		return seen.opts;
	};
	return { store, storeKey: `cwd:${dir}`, run };
}

const HUGE_SYS_PROMPT = "S".repeat(21_000);

test("stream-json budgets the inline system prompt of a user-configured AGY_AGENT (digest skipped, never an over-cap prompt)", async () => {
	await withIsolatedHome(() => withEnv(
		{ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "on", AGY_AGENT: "test-agent" },
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-sysagent-"));
			try {
				const h = inlineSysHarness(dir);
				// Prompt + inline system block + digest would cross the cap;
				// prompt + block alone must still ship, and the pending delta
				// must be kept for a later, lighter turn.
				const first = await h.run(HUGE_SYS_PROMPT, [
					userMessage("m1"),
					assistantMessage("claude", "claude says hi"),
					userMessage("current"),
				]);
				const prompt = first?.prompt ?? "";
				assert.equal(first?.agent, "test-agent", "the user-configured agent wins");
				assert.equal(countOccurrences(prompt, SYSTEM_PROMPT_PREAMBLE), 1, "the inline block rides the prompt");
				assert.ok(prompt.includes(HUGE_SYS_PROMPT));
				assert.ok(prompt.includes(TOOL_PRIORITY_NOTE));
				assert.ok(!prompt.includes("context from the broader pi session"), "an over-budget digest is skipped");
				const rec = h.store.get(h.storeKey);
				assert.equal(rec?.lastMessageCount, 0, "no trusted prior watermark: the delta is kept");

				// A later bound turn (no inline block) delivers the held handoff.
				const second = await h.run(HUGE_SYS_PROMPT, [
					userMessage("m1"),
					assistantMessage("claude", "claude says hi"),
					assistantMessage("antigravity", "agy answered"),
					userMessage("current fit"),
				]);
				assert.equal(countOccurrences(second?.prompt ?? "", SYSTEM_PROMPT_PREAMBLE), 0, "a bound turn ships no inline block");
				assert.equal(countOccurrences(second?.prompt ?? "", "claude says hi"), 1, "the pending delta is delivered on the smaller turn");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	));
});

test("stream-json budgets the inline system-prompt fallback after a staging failure (digest skipped, never an over-cap prompt)", async () => {
	await withIsolatedHome(() => withEnv(
		{ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined, AGY_SYSTEM_PROMPT: "on", AGY_AGENT: undefined },
		async () => {
			resetSyspromptAgentForTests();
			// An agents root that cannot be created: stageSyspromptAgent fails
			// and the block falls back to riding the prompt inline.
			const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agents-block-"));
			const blockedRoot = path.join(parent, "not-a-dir");
			fs.writeFileSync(blockedRoot, "not a directory", { mode: 0o600 });
			process.env.AGY_AGENTS_ROOT = blockedRoot;
			try {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skip-sysfall-"));
				try {
					const bigSys = "T".repeat(21_000);
					const h = inlineSysHarness(dir);
					const first = await h.run(bigSys, [
						userMessage("m1"),
						assistantMessage("claude", "claude says hi"),
						userMessage("current"),
					]);
					const prompt = first?.prompt ?? "";
					assert.equal(first?.agent, undefined, "staging failed: no carrier agent");
					assert.equal(countOccurrences(prompt, SYSTEM_PROMPT_PREAMBLE), 1, "the block falls back inline");
					assert.ok(prompt.includes(bigSys));
					assert.ok(prompt.includes(TOOL_PRIORITY_NOTE));
					assert.ok(!prompt.includes("context from the broader pi session"), "an over-budget digest is skipped");
					const rec = h.store.get(h.storeKey);
					assert.equal(rec?.lastMessageCount, 0, "no trusted prior watermark: the delta is kept");
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			} finally {
				delete process.env.AGY_AGENTS_ROOT;
				fs.rmSync(parent, { recursive: true, force: true });
			}
		},
	));
});
