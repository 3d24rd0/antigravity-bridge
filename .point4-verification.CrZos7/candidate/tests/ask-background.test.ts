// Background AskAntigravity runs: the call returns a `bg_` runId at once, the
// detached `agy -p` keeps going without pi's per-call abort signal, and the
// full answer arrives as ONE UNTRUSTED-tagged wake message (pi.sendMessage,
// customType ask-antigravity-result) carrying the conversationId resume handle.
//
// Upstream reference: pi-ask-antigravity. What is covered here, per rule:
// 1. return-at-once + survives the per-call abort (Esc) + wake shape
// 2. settle on stream close (not exit), exactly one wake
// 3. concurrency cap 4 with a visible refusal, one run per conversationId
// 4. /agy stop [runId-prefix], and the finishing-window refusal
// 5. session_shutdown kills silently; print/json mode refuses background
// 6. MCP suppression released exactly once, at run end
// 7. bounded stdout/stderr buffers
// plus the preserved blocking behaviour (pre-existing surface).
//
// Run: npm test

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, test, vi } from "vitest";

// The tool reads agy's conversation dir at module load; keep the discovery
// scans inside a temp dir instead of the user's real one.
const CONV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agy-conv-bg-"));
process.env.AGY_CONVERSATIONS_DIR = CONV_ROOT;

const suppression: Array<"acquire" | "release"> = [];
vi.mock("../src/mcp-registration.js", () => ({
	acquireBridgeSuppression: () => {
		suppression.push("acquire");
		let released = false;
		return () => {
			if (released) return;
			released = true;
			suppression.push("release");
		};
	},
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	beginBackgroundRun,
	endBackgroundRun,
	markBackgroundFinishing,
	registerBackgroundKill,
	resetBackgroundState,
	settleBackgroundRun,
	stopBackgroundRun,
} from "../src/ask-background.js";

type ToolResult = { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> };
type Wake = {
	customType: string;
	content: string;
	display: boolean;
	options?: { triggerTurn?: boolean; deliverAs?: string };
};

interface Harness {
	tool: {
		name: string;
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: Record<string, unknown>,
		) => Promise<ToolResult>;
	};
	wakes: Wake[];
	notices: string[];
	runAgy: (args: string) => Promise<void>;
	shutdown: () => void;
	dispose: () => void;
}

const BINS: string[] = [];
const PREV_BIN = process.env.AGY_BIN;

/** Fake `agy` built from a bash body. Each script is unique per test. */
function makeAgy(body: string[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-bg-"));
	const bin = path.join(dir, "agy");
	fs.writeFileSync(bin, ["#!/usr/bin/env bash", ...body, ""].join("\n"), { mode: 0o755 });
	BINS.push(dir);
	return bin;
}

/** Simulate a new agy conversation database (the resume handle). */
function agyCreatesConversation(id: string): string {
	return `: > ${JSON.stringify(path.join(CONV_ROOT, `${id}.db`))}`;
}

function useBin(bin: string): void {
	process.env.AGY_BIN = bin;
}

async function makeHarness(): Promise<Harness> {
	const wakes: Wake[] = [];
	const notices: string[] = [];
	const handlers = new Map<string, Array<(event?: unknown) => unknown>>();
	const tools: Array<{ name: string; execute: Harness["tool"]["execute"] }> = [];
	const commands = new Map<string, { handler: (args: string, cmdCtx: unknown) => Promise<void> }>();

	const fakePi = {
		registerTool: (tool: { name: string; execute: Harness["tool"]["execute"] }) => tools.push(tool),
		sendMessage: (message: Omit<Wake, "options">, options?: Wake["options"]) =>
			wakes.push({ ...message, options }),
		on: (event: string, handler: (event?: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, def: { handler: (args: string, cmdCtx: unknown) => Promise<void> }) =>
			commands.set(name, def),
	} as unknown as ExtensionAPI;

	const { registerAskAntigravityTool } = await import("../src/ask-tool.js");
	const { registerAgyCommand } = await import("../src/commands.js");
	await registerAskAntigravityTool(fakePi, []);
	registerAgyCommand(fakePi, {
		fileLog: { log: () => {} },
		entries: [],
		store: { size: 0, clear: () => {} },
	} as unknown as Parameters<typeof registerAgyCommand>[1]);

	expect(tools).toHaveLength(1);
	expect(commands.has("agy")).toBe(true);

	return {
		tool: tools[0],
		wakes,
		notices,
		runAgy: async (args: string) => {
			await commands.get("agy")!.handler(args, {
				mode: "tui",
				hasUI: true,
				ui: { notify: (message: string) => notices.push(message) },
			});
		},
		shutdown: () => {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({});
		},
		dispose: () => {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({});
			if (PREV_BIN === undefined) delete process.env.AGY_BIN;
			else process.env.AGY_BIN = PREV_BIN;
		},
	};
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
	const h = await makeHarness();
	try {
		await fn(h);
	} finally {
		h.dispose();
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
		await sleep(10);
	}
}

function makeCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-cwd-bg-"));
}

function runIdOf(text: string): string {
	const match = /bg_[0-9a-f]{8}/.exec(text);
	expect(match, `expected a bg_ runId in: ${text}`).not.toBeNull();
	return match![0];
}

afterAll(() => {
	for (const dir of BINS) fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(CONV_ROOT, { recursive: true, force: true });
	delete process.env.AGY_CONVERSATIONS_DIR;
});

// --- Rule 1: return at once, survive the per-call abort, deliver one wake ---

test(
	"background returns a bg_ runId at once and the answer arrives later as one UNTRUSTED wake",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(
				makeAgy([
					agyCreatesConversation("conv-bg-one"),
					"printf 'FULL-ANSWER-ONE\\n'",
					// Still alive when execute() has already returned.
					"sleep 1.5",
				]),
			);
			const cwd = makeCwd();
			const abort = new AbortController();
			const start = Date.now();
			const res = await h.tool.execute(
				"t1",
				{ prompt: "delegate", cwd, background: true, timeoutMinutes: 1 },
				abort.signal,
				undefined,
				{ cwd, mode: "tui" },
			);
			const returnedMs = Date.now() - start;

			// Returns at once: no answer yet, and well before the run ends.
			expect(returnedMs).toBeLessThan(1000);
			expect(h.wakes).toHaveLength(0);
			const runId = runIdOf(res.content[0].text);
			expect(res.content[0].text).toContain("Background run");
			expect(res.details?.refused).toBeFalsy();

			// Esc after the call: the detached run must not be killed by it.
			abort.abort();

			await waitFor(() => h.wakes.length > 0);
			await sleep(200);
			expect(h.wakes).toHaveLength(1);
			const wake = h.wakes[0];
			expect(wake.customType).toBe("ask-antigravity-result");
			expect(wake.display).toBe(true);
			expect(wake.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
			expect(wake.content).toContain(`Background run ${runId}`);
			expect(wake.content).toContain("FULL-ANSWER-ONE");
			expect(wake.content).not.toContain("aborted");
			// Resume handle: the conversation agy created mid-run.
			expect(wake.content).toContain("conversationId=conv-bg-one");
			expect(wake.content).toMatch(/UNTRUSTED/);
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

// --- Rule 2: settle on stream close, never on process exit -----------------

test(
	"the run settles on stream close, so a trailing write from a stray child is not truncated",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(
				makeAgy([
					agyCreatesConversation("conv-bg-close"),
					"printf 'PART-ONE\\n'",
					// Inherits stdout and outlives the shell: `exit` fires first, the
					// pipe only closes when this child is gone.
					"( sleep 0.5; printf 'PART-TWO\\n' ) &",
					"exit 0",
				]),
			);
			const cwd = makeCwd();
			await h.tool.execute(
				"t1",
				{ prompt: "delegate", cwd, background: true, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);

			await waitFor(() => h.wakes.length > 0);
			await sleep(300);
			// Exactly one wake: the exit-then-close pair must not double-deliver.
			expect(h.wakes).toHaveLength(1);
			expect(h.wakes[0].content).toContain("PART-ONE");
			expect(h.wakes[0].content).toContain("PART-TWO");
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

// --- Rule 3: concurrency cap and the per-conversation lock -----------------

test(
	"the fifth concurrent background run is refused with a visible message",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(makeAgy(["sleep 5"]));
			const cwd = makeCwd();
			for (let i = 0; i < 4; i++) {
				const res = await h.tool.execute(
					`t${i}`,
					{ prompt: `run ${i}`, cwd, background: true, timeoutMinutes: 1 },
					undefined,
					undefined,
					{ cwd, mode: "tui" },
				);
				runIdOf(res.content[0].text);
			}
			const refused = await h.tool.execute(
				"t5",
				{ prompt: "run 5", cwd, background: true, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			expect(refused.content[0].text).toMatch(/background refused/);
			expect(refused.content[0].text).toContain("4");
			expect(refused.content[0].text).toContain("/agy stop");
			expect(refused.details?.refused).toBe(true);
			expect(h.wakes).toHaveLength(0);
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

test(
	"a conversation with a run in flight refuses a blocking resume of the same conversation",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(makeAgy(["sleep 2"]));
			const cwd = makeCwd();
			const bg = await h.tool.execute(
				"t1",
				{ prompt: "resume", cwd, background: true, conversationId: "conv-shared-1", timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			runIdOf(bg.content[0].text);

			const blocked = await h.tool.execute(
				"t2",
				{ prompt: "resume blocking", cwd, conversationId: "conv-shared-1", timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			expect(blocked.content[0].text).toContain("already has a run in flight");
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

// --- Rule 4: /agy stop ----------------------------------------------------

test(
	"stop with no argument stops the only running run and delivers exactly one wake",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(makeAgy(["sleep 5"]));
			const cwd = makeCwd();
			const res = await h.tool.execute(
				"t1",
				{ prompt: "long run", cwd, background: true, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			const runId = runIdOf(res.content[0].text);

			await h.runAgy("stop");
			expect(h.notices.at(-1)).toContain(`Stopped ${runId}`);

			await waitFor(() => h.wakes.length > 0);
			// The killed child closing must not produce a second wake.
			await sleep(500);
			expect(h.wakes).toHaveLength(1);
			expect(h.wakes[0].content).toContain("FAILED");
			expect(h.wakes[0].content).toContain(`stopped via /agy stop`);

			await h.runAgy("stop");
			expect(h.notices.at(-1)).toContain("No background AskAntigravity runs are running");
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

test(
	"stop by runId prefix stops the named run; an unmatched prefix names the running ones",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(makeAgy(["sleep 5"]));
			const cwd = makeCwd();
			const a = await h.tool.execute(
				"t1",
				{ prompt: "run a", cwd, background: true, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			const b = await h.tool.execute(
				"t2",
				{ prompt: "run b", cwd, background: true, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			const runId = runIdOf(a.content[0].text);
			const other = runIdOf(b.content[0].text);

			// No argument with two running: nothing is stopped, both are named.
			await h.runAgy("stop");
			expect(h.notices.at(-1)).toContain(runId);
			expect(h.notices.at(-1)).toContain(other);
			expect(h.notices.at(-1)).not.toContain("Stopped");

			await h.runAgy(`stop ${runId.slice(0, 6)}`);
			expect(h.notices.at(-1)).toContain(`Stopped ${runId}`);
			await waitFor(() => h.wakes.length === 1);
			expect(h.wakes[0].content).toContain(runId);

			await h.runAgy("stop zzzz");
			expect(h.notices.at(-1)).toContain("No background run matches");
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

test("stop refuses inside the finishing window instead of discarding the answer", () => {
	// The window opens when the child's stream closes and closes when the answer
	// settles: discovery still runs in between. Driving it through a real child
	// meant racing a few milliseconds and stopping the run for real, so the guard
	// is pinned here and the delivery path stays covered by the wake tests.
	resetBackgroundState();
	const run = beginBackgroundRun("quick run");
	const killed: string[] = [];
	registerBackgroundKill(run.runId, () => killed.push(run.runId));
	markBackgroundFinishing(run.runId);

	const wakes: Array<{ content: string }> = [];
	const target = { sendMessage: (message: { content: string }) => wakes.push(message) };

	expect(stopBackgroundRun(target, run.runId)).toContain(
		"already finished; its result is being delivered",
	);
	expect(killed).toEqual([]);
	expect(wakes).toEqual([]);

	// Once the answer settled, the same stop reports the run instead of killing it.
	expect(settleBackgroundRun(run.runId, "done")).toBe(true);
	endBackgroundRun(run.runId);
	expect(stopBackgroundRun(target, run.runId)).toContain("not running (status: done)");
	expect(killed).toEqual([]);
});

// --- Rule 5: shutdown kills silently; print/json refuses background --------

test(
	"session_shutdown kills in-flight background runs silently",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(makeAgy(["sleep 5"]));
			const cwd = makeCwd();
			await h.tool.execute(
				"t1",
				{ prompt: "long run", cwd, background: true, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			h.shutdown();
			await sleep(600);
			expect(h.wakes).toHaveLength(0);
			await h.runAgy("stop");
			expect(h.notices.at(-1)).toContain("No background AskAntigravity runs are running");
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

test(
	"background is refused in print/json mode, where the process exits before the wake",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			const marker = path.join(os.tmpdir(), `agy-bg-marker-${process.pid}-${Date.now()}`);
			useBin(makeAgy([`: > ${JSON.stringify(marker)}`, "printf 'RAN\\n'"]));
			const cwd = makeCwd();
			try {
				for (const mode of ["print", "json"]) {
					const res = await h.tool.execute(
						"t1",
						{ prompt: "delegate", cwd, background: true, timeoutMinutes: 1 },
						undefined,
						undefined,
						{ cwd, mode },
					);
					expect(res.content[0].text).toMatch(/background is not available in print\/json mode/);
					expect(res.details?.refused).toBe(true);
				}
				expect(h.wakes).toHaveLength(0);
				expect(fs.existsSync(marker)).toBe(false);
			} finally {
				fs.rmSync(marker, { force: true });
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}),
);

// --- Rule 6: suppression lives for the whole background run ----------------

test(
	"bridge suppression is released exactly once, at the end of a background run",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(makeAgy([agyCreatesConversation("conv-bg-supp"), "printf 'ANSWER-SUPP\\n'", "sleep 0.4"]));
			const cwd = makeCwd();
			suppression.length = 0;
			await h.tool.execute(
				"t1",
				{ prompt: "delegate", cwd, background: true, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			// execute() returned while agy is still alive: the window stays open.
			expect(suppression).toEqual(["acquire"]);

			await waitFor(() => h.wakes.length > 0);
			await sleep(300);
			expect(suppression).toEqual(["acquire", "release"]);
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

// --- Rule 7: bounded buffers (shared by both modes) -----------------------

test(
	"stdout is capped at 1M chars and stderr at 64k, so a runaway run cannot grow memory",
	{ timeout: 30_000 },
	() =>
		withHarness(async (h) => {
			const cwd = makeCwd();
			// The blocking path returns the answer directly, so the caps in the
			// shared run lifecycle are observable here.
			useBin(makeAgy(['node -e \'process.stdout.write("x".repeat(1200000))\'', "exit 0"]));
			const flooded = await h.tool.execute(
				"t1",
				{ prompt: "flood", cwd, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			const length = flooded.content[0].text.length;
			expect(length).toBeGreaterThan(900_000);
			expect(length).toBeLessThan(1_100_000);

			useBin(makeAgy(['node -e \'process.stderr.write("E".repeat(100000))\'', "exit 3"]));
			const crashed = await h.tool.execute(
				"t2",
				{ prompt: "crash", cwd, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			const text = crashed.content[0].text;
			expect(text).toContain("agy exited with status 3");
			const stderrPart = text.slice(text.indexOf("status 3:"));
			expect(stderrPart.length).toBeGreaterThan(60_000);
			expect(stderrPart.length).toBeLessThan(70_000);
			expect(h.wakes).toHaveLength(0);
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);

// --- Preserved: the blocking path is unchanged ----------------------------

test(
	"blocking asks still return the answer inline with the conversationId footer and no wake",
	{ timeout: 20_000 },
	() =>
		withHarness(async (h) => {
			useBin(makeAgy([agyCreatesConversation("conv-block-1"), "printf 'BLOCK-ANSWER\\n'"]));
			const cwd = makeCwd();
			const res = await h.tool.execute(
				"t1",
				{ prompt: "delegate", cwd, timeoutMinutes: 1 },
				undefined,
				undefined,
				{ cwd, mode: "tui" },
			);
			expect(res.content[0].text).toBe(
				"BLOCK-ANSWER\n\n[agy conversationId: conv-block-1 - pass as conversationId to continue this conversation]",
			);
			expect(h.wakes).toHaveLength(0);
			expect(suppression.at(-1)).toBe("release");
			fs.rmSync(cwd, { recursive: true, force: true });
		}),
);
