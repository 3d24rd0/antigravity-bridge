// Stall recovery + late-result routing regressions (audit 2026-11).
//
// S1: a turn that stalls AFTER streaming text still settles OK with the
//     transcript-recovered answer. Emitting only when nothing was streamed
//     discarded that answer in its commonest case.
// S2: a stranded escalated result stamped with an older conversation must not
//     move the current turn there nor delete the current binding.
// S3: the silent-over-cap guard also covers the late redelivery turn.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { DriverActivity, DriverTurnRequest, StreamDriver } from "../src/driver.js";
import type { TurnHandle, TurnOutcome } from "../src/driver-types.js";

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

const SESSION_KEY = "sid:s1";

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-stall-")), "sessions.json");
}

interface ScriptedTurn {
	activities: DriverActivity[];
	outcome: TurnOutcome;
	/** Runs when the provider dispatches this turn (mid-turn side effects). */
	onRun?: () => void;
}

/** Driver with one scripted turn per call. The outcome conversation echoes the
 *  request unless the script sets one explicitly, which is what makes a
 *  re-routed turn visible. */
function scriptedDriver(turns: ScriptedTurn[]): { driver: StreamDriver; seen: DriverTurnRequest[] } {
	const seen: DriverTurnRequest[] = [];
	let dispatched = 0;
	const driver = {
		activeHandle: null,
		kickIdle: () => {},
		reentry: () => null,
		snapshot: () => ({}),
		close: async () => {},
		run: async (opts: DriverTurnRequest) => {
			seen.push(opts);
			const turn = turns[Math.min(dispatched++, turns.length - 1)];
			turn.onRun?.();
			let idx = 0;
			const handle = {
				id: `turn-${dispatched}`,
				outcome: Promise.resolve({
					...turn.outcome,
					conversationId:
						"conversationId" in turn.outcome ? turn.outcome.conversationId : (opts.conversationId ?? undefined),
				}),
				next: async (): Promise<DriverActivity | null> =>
					idx < turn.activities.length ? turn.activities[idx++] : null,
				pushExternal: () => {},
			};
			return handle as unknown as TurnHandle;
		},
	};
	return { driver: driver as unknown as StreamDriver, seen };
}

function idleRoundTrips(): ToolRoundTrips {
	return new ToolRoundTrips(() => ({ activeHandle: null }) as unknown as StreamDriver);
}

/** Driver stub with an always-active handle, so bridge parks can be opened in
 *  tests without a real turn. */
function parkingDriver(): StreamDriver {
	const handle = {
		id: "probe",
		outcome: new Promise<never>(() => {}),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: () => {},
	};
	return {
		get activeHandle() {
			return handle;
		},
		kickIdle: () => {},
		reentry: () => null,
		snapshot: () => ({}),
		close: async () => {},
		run: async () => handle,
	} as unknown as StreamDriver;
}

async function drain(s: AsyncIterable<unknown>): Promise<{ message: AssistantMessage; errors: AssistantMessage[] }> {
	let message: AssistantMessage | undefined;
	const errors: AssistantMessage[] = [];
	for await (const raw of s) {
		const ev = raw as { type: string; message?: AssistantMessage; error?: AssistantMessage };
		if (ev.type === "done" && ev.message) message = ev.message;
		if (ev.type === "error" && ev.error) errors.push(ev.error);
	}
	if (errors.length === 0) assert.ok(message, "a successful stream must end with a done message");
	return { message: message as AssistantMessage, errors };
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
}

function userTurn(text: string): TranscriptContext {
	return normalizeContext({
		systemPrompt: undefined,
		messages: [{ role: "user", content: text, timestamp: Date.now() }],
	});
}

const options = { sessionId: "s1", cwd: process.cwd() } as unknown as SimpleStreamOptions;

test("S1 stall recovery: recovered answer extends the streamed fragment", async () => {
	const { driver } = scriptedDriver([
		{
			activities: [{ type: "text", delta: "Paris is the cap" }],
			// What #turnDeadlineGuard recovers from the transcript after the stall.
			outcome: { status: "OK", response: "Paris is the capital of France.", finished: true, aborted: false },
		},
	]);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: idleRoundTrips(),
	});
	const { message, errors } = await drain(streamSimple(model, userTurn("capital?"), options));
	assert.deepEqual(errors, []);
	assert.equal(textOf(message), "Paris is the capital of France.");
});

test("S1 stall recovery: divergent recovered answer keeps the fragment and adds the answer", async () => {
	const { driver } = scriptedDriver([
		{
			activities: [{ type: "text", delta: "partial fragment" }],
			outcome: { status: "OK", response: "the full recovered answer", finished: true, aborted: false },
		},
	]);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: idleRoundTrips(),
	});
	const { message } = await drain(streamSimple(model, userTurn("question"), options));
	const texts = message.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text);
	assert.ok(texts.includes("partial fragment"), "the emitted fragment must stay visible");
	assert.ok(texts.includes("the full recovered answer"), "the recovered answer must not be dropped");
});

test("S1c stall recovery: a thought block between fragment and recovery does not duplicate it", async () => {
	const { driver } = scriptedDriver([
		{
			activities: [
				{ type: "text", delta: "Paris is the cap" },
				// A thought closes the text block, so the open-block index is null
				// while the fragment is still on screen.
				{ type: "thought", delta: "considering the rest" },
			],
			outcome: { status: "OK", response: "Paris is the capital of France.", finished: true, aborted: false },
		},
	]);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: idleRoundTrips(),
	});
	const { message } = await drain(streamSimple(model, userTurn("capital?"), options));
	assert.equal(textOf(message), "Paris is the capital of France.", "the streamed fragment must not be duplicated");
});

test("S2 late strand: turn stays on the current conversation and the binding survives", async () => {
	// A stranded result that belongs to the PREVIOUS conversation.
	const rt = new ToolRoundTrips(parkingDriver(), undefined, { escalateAfterMs: 1 });
	const escalated = rt.onToolCall("call-a", "AskClaude", {}, new AbortController().signal);
	await escalated;
	// Real order: the turn ends while the call is still running, so the stamp
	// lands on the RUNNING entry; the result settles later.
	rt.stampConversation("conv-A");
	rt.resolve("call-a", "LATE OUTPUT", false);

	const store = new SessionStore(tmpStorePath());
	store.set(SESSION_KEY, {
		conversationId: "conv-B",
		lastStepIdx: -1,
		lastMessageCount: 0,
		modelId: "gemini-3.6-flash",
	});

	const { driver, seen } = scriptedDriver([
		{ activities: [], outcome: { status: "OK", response: "ok", finished: true, aborted: false } },
	]);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		roundTrips: rt,
	});
	await drain(streamSimple(model, userTurn("next question"), options));

	assert.equal(seen.length, 1, "one turn dispatched");
	assert.equal(seen[0].conversationId, "conv-B", "the late result must not move the turn to conv-A");
	assert.ok(seen[0].prompt.includes("LATE OUTPUT"), "the late result still rides the prompt");
	assert.equal(store.get(SESSION_KEY)?.conversationId, "conv-B", "the current binding must survive");
});

test("S3 late redelivery: an over-cap silent drop fails visibly and clears the binding", async () => {
	const rt = new ToolRoundTrips(parkingDriver(), undefined, { escalateAfterMs: 1 });
	// A: already settled before the turn starts, so the continuation runs.
	await rt.onToolCall("call-a", "AskClaude", {}, new AbortController().signal);
	rt.stampConversation("conv-B");
	rt.resolve("call-a", "LATE A", false);
	// B: settles DURING the turn, so only the gap closer can deliver it.
	await rt.onToolCall("call-b", "AskClaude", {}, new AbortController().signal);

	// A pending toolResult makes this pass a continuation.
	rt.track("tc1", "read");
	const context = normalizeContext({
		systemPrompt: undefined,
		messages: [
			{ role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() },
			{ role: "toolResult", toolCallId: "call-a", content: [{ type: "text", text: "LATE A" }], isError: false, timestamp: Date.now() },
			{ role: "user", content: "carry on", timestamp: Date.now() },
		],
	} as unknown as Parameters<typeof normalizeContext>[0]);

	const store = new SessionStore(tmpStorePath());
	store.set(SESSION_KEY, {
		conversationId: "conv-B",
		lastStepIdx: -1,
		lastMessageCount: 0,
		modelId: "gemini-3.6-flash",
	});

	const { driver } = scriptedDriver([
		// Main turn: settles B mid-turn, then reports normal output.
		{ activities: [], outcome: { status: "OK", response: "main ok", finished: true, aborted: false }, onRun: () => rt.resolve("call-b", "LATE B", false) },
		// Late redelivery turn: agy's silent over-cap signature.
		{ activities: [], outcome: { status: "OK", response: "", finished: true, aborted: false, modelOutputSeen: false } },
	]);
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		roundTrips: rt,
	});
	const { errors } = await drain(streamSimple(model, context, options));
	assert.equal(errors.length, 1, "an over-cap late redelivery must surface an error, not an empty OK");
	assert.match(errors[0].errorMessage ?? "", /no model output|silently dropped/i);
	assert.equal(store.get(SESSION_KEY), null, "the poisoned binding must be cleared");
});
