import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { normalizeContext, type Api, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createStreamSimple, ToolRoundTrips } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle, TurnOutcome } from "../src/driver-types.js";

const notice = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 153h38m14s";
const error = "agy rate limit (ResourceExhausted): Antigravity quota exhausted; resets in 153h38m14s";
const model: Model<Api> = { id: "gemini-flash", name: "Gemini", api: "agy-bridge" as Api, provider: "antigravity", baseUrl: "agy-bridge://antigravity", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1000 };
interface Script { response?: string; activities?: DriverActivity[]; status?: TurnOutcome["status"]; aborted?: boolean; error?: string; conversationId?: string }
const dirs: string[] = [];
beforeEach(() => { vi.stubEnv("AGY_DIGEST", "1"); vi.stubEnv("AGY_SYSTEM_PROMPT", "off"); });
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function harness(scripts: Script[], engine: "acp" | "stream-json" = "stream-json") {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-")); dirs.push(dir);
 const requests: DriverTurnRequest[] = [];
 const driver = { run: async (request: DriverTurnRequest) => {
  requests.push(request); const script = scripts.shift() ?? {}; const queue = [...(script.activities ?? [])];
  return { id: "turn", next: async () => queue.shift() ?? null, pushExternal: () => {}, outcome: Promise.resolve({ status: script.status ?? "OK", response: script.response ?? "", finished: true, aborted: script.aborted ?? false, conversationId: script.conversationId ?? "conv", error: script.error }) };
 }, reentry: () => null } as unknown as TurnDriver;
 const stream = createStreamSimple({ entries: [{ id: "gemini-flash", full: "gemini-3.6-flash" }], store: new SessionStore(path.join(dir, "sessions.json")), driver, ...(engine === "acp" ? { acpDriver: driver } : {}), engine, roundTrips: new ToolRoundTrips(driver) });
 return { requests, run: async (messages: string[]) => {
  const context = normalizeContext({ messages: messages.map(content => ({ role: "user" as const, content, timestamp: 1 })) });
  const events = []; for await (const event of stream(model, context, { cwd: dir } as SimpleStreamOptions)) events.push(event);
  const terminal = events.at(-1); assert.ok(terminal && (terminal.type === "done" || terminal.type === "error"));
  return terminal;
 } };
}
for (const engine of ["stream-json", "acp"] as const) {
 test(`${engine}: result-only notice is a retryable error`, async () => {
  const h = harness([{ response: notice }], engine); const event = await h.run(["hello"]);
  assert.equal(event.type, "error"); if (event.type !== "error") return;
  assert.equal(event.reason, "error"); assert.equal(event.error.errorMessage, error); assert.equal(isRetryableAssistantError(event.error), true);
 });
}
test("split streamed notice without result is an error", async () => {
 const h = harness([{ activities: [{ type: "text", delta: notice.slice(0, 35) }, { type: "text", delta: notice.slice(35) }] }]);
 const event = await h.run(["hello"]); assert.equal(event.type, "error"); if (event.type === "error") assert.equal(event.error.errorMessage, error);
});
test("quota does not bind a first turn and re-delivers context", async () => {
 const h = harness([{ response: notice }, { response: "ok" }]);
 await h.run(["missed"]); const event = await h.run(["missed", "next"]);
 assert.equal(event.type, "done"); assert.equal(h.requests[1].conversationId, null); assert.match(h.requests[1].prompt, /missed/);
});
test("quota preserves a bound watermark and re-delivers missed context", async () => {
 const h = harness([{ response: "ok" }, { response: notice }, { response: "ok" }]);
 await h.run(["first"]); await h.run(["first", "missed"]); await h.run(["first", "missed", "next"]);
 assert.equal(h.requests[2].conversationId, "conv"); assert.match(h.requests[2].prompt, /missed/);
});
test("notice whitespace, optional glyph and reset, and recovered full result", async () => {
 const base = "Individual quota reached. Please upgrade your subscription to increase your limits.";
 for (const response of [` \n${base}\n`, `⚠ ${base}\nResets in 5m`]) {
  const event = await harness([{ response, activities: [{ type: "text", delta: response.slice(0, 15) }] }]).run(["hello"]);
  assert.equal(event.type, "error"); if (event.type === "error") assert.equal(event.error.errorMessage, `agy rate limit (ResourceExhausted): Antigravity quota exhausted${response.includes("5m") ? "; resets in 5m" : ""}`);
 }
});
test("a recreated conversation is invalidated even on quota", async () => {
 const h = harness([{ response: "ok" }, { response: notice, conversationId: "new" }, { response: "ok" }]);
 await h.run(["first"]); await h.run(["first", "missed"]); await h.run(["first", "missed", "next"]);
 assert.equal(h.requests[2].conversationId, null); assert.match(h.requests[2].prompt, /first/);
});
test("ordinary discussion, quoted notice and suffix prose remain successful", async () => {
 for (const response of ["Daily quota reached", `About quota: ${notice}`, `\"${notice}\"`, `\`\`\`${notice}\`\`\``, `${notice} Please wait.`, notice.replace("Individual", "Daily"), notice.replace("153h38m14s", "billing")]) {
  const event = await harness([{ response }]).run(["hello"]); assert.equal(event.type, "done"); if (event.type === "done") assert.equal(event.message.content[0]?.type === "text" && event.message.content[0].text, response);
 }
});
test("thoughts and tools prevent classification", async () => {
 for (const activity of [{ type: "thought", tokens: 1 }, { type: "tool_start", name: "read", args: {} }] as DriverActivity[]) {
  const event = await harness([{ response: notice, activities: [activity] }]).run(["hello"]); assert.equal(event.type, "done");
 }
});
test("native errors and aborts retain their reasons", async () => {
 for (const script of [{ response: notice, status: "ERROR" as const, error: "native failure" }, { response: notice, aborted: true }]) {
  const event = await harness([script]).run(["hello"]); assert.equal(event.type, "error"); if (event.type === "error") { assert.equal(event.reason, script.aborted ? "aborted" : "error"); assert.equal(event.error.errorMessage, script.aborted ? "Operation aborted" : "native failure"); }
 }
});

function userMessage(content: string): Message {
	return { role: "user", content, timestamp: 1 };
}

function toolResult(callId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: callId,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as unknown as Message;
}

function scriptedHandle(activities: DriverActivity[], outcome: Partial<TurnOutcome> = {}): TurnHandle {
	return {
		id: "turn",
		next: async () => activities.shift() ?? null,
		pushExternal: (activity) => activities.push(activity),
		outcome: Promise.resolve({
			status: "OK", response: notice, finished: true, aborted: false,
			conversationId: "conv", ...outcome,
		}),
	};
}

async function terminal(
	stream: ReturnType<ReturnType<typeof createStreamSimple>>,
) {
	const events = [];
	for await (const event of stream) events.push(event);
	const last = events.at(-1);
	assert.ok(last && (last.type === "done" || last.type === "error"));
	return last;
}

test("a parked bridge call keeps toolUse and a notice-bearing continuation resumes its binding", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-"));
	dirs.push(dir);
	const requests: DriverTurnRequest[] = [];
	const parked = scriptedHandle([{ type: "text", delta: notice }]);
	const driver = {
		activeHandle: parked,
		kickIdle: () => {},
		reentry: () => parked,
		snapshot: () => ({ conversationId: "conv" }),
		run: async (request: DriverTurnRequest) => {
			requests.push(request);
			return requests.length === 1 ? parked : scriptedHandle([], { response: "ok" });
		},
	} as unknown as TurnDriver;
	const roundTrips = new ToolRoundTrips(driver, undefined, { escalateAfterMs: 0 });
	const result = roundTrips.onToolCall("call-1", "read", {}, new AbortController().signal);
	const stream = createStreamSimple({
		entries: [{ id: "gemini-flash", full: "gemini-3.6-flash" }],
		store: new SessionStore(path.join(dir, "sessions.json")), driver, roundTrips,
	});
	const options = { cwd: dir } as SimpleStreamOptions;
	const first = await terminal(stream(model, normalizeContext({ messages: [userMessage("first")] }), options));
	assert.equal(first.type, "done");
	if (first.type !== "done") return;
	assert.equal(first.reason, "toolUse");
	assert.deepEqual(first.message.content.find((block) => block.type === "toolCall"), {
		type: "toolCall", id: "call-1", name: "read", arguments: {},
	});

	const continuation = await terminal(stream(model, normalizeContext({
		messages: [userMessage("first"), toolResult("call-1", "file contents")],
	}), options));
	assert.equal(continuation.type, "done");
	if (continuation.type !== "done") return;
	assert.equal(continuation.reason, "stop");
	assert.equal(continuation.message.content[0]?.type === "text" && continuation.message.content[0].text, notice);
	const resolved = await result;
	assert.ok(!("escalated" in resolved));
	assert.deepEqual(resolved.content, [{ type: "text", text: "file contents" }]);
	assert.equal(requests.length, 1, "continuation reattaches without starting a new turn");

	const next = await terminal(stream(model, normalizeContext({
		messages: [userMessage("first"), toolResult("call-1", "file contents"), userMessage("next")],
	}), options));
	assert.equal(next.type, "done");
	assert.equal(requests[1].conversationId, "conv");
	assert.equal(requests[1].prompt, "next");
});

test("live continuation redelivers a tool result and preserves native stop or error", async () => {
	for (const failure of [false, true]) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-"));
		dirs.push(dir);
		const requests: DriverTurnRequest[] = [];
		const active = scriptedHandle([{ type: "thought", tokens: 1 }], { response: "" });
		// The escalated bridge call already parked on the earlier pi pass.
		active.pushExternal = () => {};
		const driver = {
			activeHandle: active,
			kickIdle: () => {},
			reentry: () => active,
			run: async (request: DriverTurnRequest) => {
				requests.push(request);
				if (requests.length > 1) return scriptedHandle([], { response: "ok" });
				return scriptedHandle([], failure ? { status: "ERROR", error: "native failure" } : {});
			},
		} as unknown as TurnDriver;
		const roundTrips = new ToolRoundTrips(driver, undefined, { escalateAfterMs: 1 });
		await roundTrips.onToolCall("call-2", "read", {}, new AbortController().signal);
		roundTrips.stampConversation("conv");
		const stream = createStreamSimple({
			entries: [{ id: "gemini-flash", full: "gemini-3.6-flash" }],
			store: new SessionStore(path.join(dir, "sessions.json")), driver, roundTrips,
		});
		const options = { cwd: dir } as SimpleStreamOptions;
		const event = await terminal(stream(model, normalizeContext({
			messages: [userMessage("first"), toolResult("call-2", "late file contents")],
		}), options));
		assert.equal(requests.length, 1);
		assert.equal(requests[0].conversationId, "conv");
		assert.match(requests[0].prompt, /Late tool delivery/);
		assert.match(requests[0].prompt, /late file contents/);
		if (failure) {
			assert.equal(event.type, "error");
			if (event.type === "error") assert.equal(event.error.errorMessage, "native failure");
		} else {
			assert.equal(event.type, "done");
			if (event.type === "done") {
				assert.equal(event.reason, "stop");
				assert.equal(event.message.content[0]?.type === "text" && event.message.content[0].text, notice);
			}
		}
		const next = await terminal(stream(model, normalizeContext({
			messages: [userMessage("first"), toolResult("call-2", "late file contents"), userMessage("next")],
		}), options));
		assert.equal(next.type, "done");
		assert.equal(requests[1].conversationId, failure ? null : "conv");
		if (failure) assert.match(requests[1].prompt, /first/);
		else assert.equal(requests[1].prompt, "next");
	}
});
