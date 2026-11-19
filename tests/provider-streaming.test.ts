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
import { ToolRoundTrips, WrapperReplay, consumeActivity, createStreamSimple, SYSTEM_PROMPT_PREAMBLE, TOOL_PRIORITY_NOTE, type BlockState } from "../src/provider.js";
import { toAgyEffort } from "../src/models.js";
import { TurnDiffContext } from "../src/diff-render.js";
import { SessionStore } from "../src/sessions.js";
import { setCachedQuotaReport } from "../src/usage.js";
import { resetSyspromptAgentForTests } from "../src/sysprompt-agent.js";
import type { DriverActivity, StreamDriver, DriverTurnRequest } from "../src/driver.js";

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

/** pi context after a compaction: the summary, then turns kept after the cut,
 *  then the current prompt. */
function compactedContext(currentPrompt: string): TranscriptContext {
	const assistantTurn = (provider: string, text: string) => ({
		role: "assistant" as const,
		provider,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
		model: "some-model",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		api: "agy-bridge" as Api,
	});
	return normalizeContext({
		systemPrompt: undefined,
		messages: [
			{ role: "user", content: "m1", timestamp: Date.now() },
			assistantTurn("claude", "claude says hi"),
			{ role: "user", content: "m2", timestamp: Date.now() },
			assistantTurn("antigravity", "pre-cut agy answer"),
			{
				role: "user",
				content:
					"The conversation history has been compacted into the following summary:\n<summary>\nsqlite was chosen\n</summary>",
				timestamp: Date.now(),
			},
			{ role: "user", content: "kept post-cut question", timestamp: Date.now() },
			assistantTurn("antigravity", "agy post-cut answer"),
			{ role: "user", content: currentPrompt, timestamp: Date.now() },
		],
	});
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test("sessionCompacted rotation ships the compaction summary + kept post-cut turns once, with digest off", async () => {
	await withEnv({ AGY_ENGINE: "stream-json", AGY_DIGEST: undefined }, async () => {
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
