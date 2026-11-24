// Delivery of the approval gate to the ACP engine (issue #18, upstream
// 62b2a20 adapted to this fork's structure). Upstream merges the session's
// gate group into a staged ACP home's config/hooks.json; THIS fork never
// stages an ACP home -- our isolation-correct channel is the session-private
// per-pid bridge dir passed as an extra --add-dir (the same channel the
// stream-json driver uses, src/driver.ts). Upstream probed that `agy acp`
// honors PreToolUse hooks from an --add-dir passthrough too (staged-home
// config/ was chosen there because that engine stages a home; we do not).
// So the driver appends --add-dir <bridgeMcpConfigDir()> at spawn when the
// gate is staged, and nothing when it is off. All staging lives in a temp
// agent dir; the fake ACP server is spawned for real argv-level assertions.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";
import { AcpDriver } from "../src/acp/driver.js";
import { bridgeMcpConfigDir } from "../src/mcp-server.js";
import { gateHooksStaged, removeGateHooks, stageGateHooks } from "../src/approval-hook.js";
import type { DriverActivity } from "../src/driver-types.js";

const FAKE_SERVER = fileURLToPath(new URL("./helpers/fake-acp-server.mjs", import.meta.url));

const tempDirs: string[] = [];
const stagedFiles: string[] = [];
afterAll(() => {
	for (const f of stagedFiles) {
		fs.rmSync(f, { force: true });
	}
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Pin PI_CODING_AGENT_DIR at a fresh temp root and stage a gate group in the
 *  per-pid bridge dir. Returns the expected delivery path. */
function stageGateInTempAgentDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-acp-agentdir-"));
	tempDirs.push(root);
	process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi", "agent");
	const dir = bridgeMcpConfigDir();
	stagedFiles.push(path.join(dir, ".agents", "hooks.json"));
	const res = stageGateHooks(dir, { port: 1, token: "t", scriptPath: "/tmp/approval-hook-test.js", parkBudgetMs: 60_000 });
	assert.equal(res.wrote, true);
	assert.equal(gateHooksStaged(), true);
	return dir;
}

function restoreAgentDir(prev: string | undefined): void {
	if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prev;
}

interface GateRun {
	outcome: { status: string; response: string };
	spawnArgs: string[] | undefined;
	cleanup: () => void;
}

/** One happy-path turn with the real fake server, capturing the driver's
 *  "spawn" log entry (bin + args) and the activities. */
async function runOnce(): Promise<GateRun> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-acp-cwd-"));
	tempDirs.push(dir);
	let spawnArgs: string[] | undefined;
	const driver = new AcpDriver({
		bin: process.execPath,
		binArgs: [FAKE_SERVER],
		usageEstimate: "off",
		log: (msg, data) => {
			if (msg === "spawn") {
				const d = data as { args?: string[] };
				spawnArgs = [...(d.args ?? [])];
			}
		},
	});
	const controller = new AbortController();
	const handle = await driver.run({
		cwd: dir,
		model: "gemini-3.8-flash",
		effort: "low",
		mode: "accept-edits",
		skipPermissions: true,
		prompt: "hi",
		signal: controller.signal,
	});
	const activities: DriverActivity[] = [];
	const collecting = (async () => {
		for (;;) {
			const activity = await handle.next();
			if (activity === null) return;
			activities.push(activity);
		}
	})();
	const outcome = await handle.outcome;
	await collecting;
	await driver.close("recycle", "gate-acp test");
	return {
		outcome: { status: outcome.status, response: outcome.response },
		spawnArgs,
		cleanup: () => controller.abort(),
	};
}

test("the ACP driver delivers the staged gate dir as an extra --add-dir (issue #18)", async () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	const gateDir = stageGateInTempAgentDir();
	try {
		const run = await runOnce();
		assert.equal(run.outcome.status, "OK", "the extra argv must not break the start");
		assert.ok(run.spawnArgs, "the driver must log its spawn argv");
		const i = run.spawnArgs!.indexOf("--add-dir");
		assert.notEqual(i, -1, `expected --add-dir in ${JSON.stringify(run.spawnArgs)}`);
		assert.equal(run.spawnArgs![i + 1], gateDir, "the private per-pid gate dir rides the ACP argv");
	} finally {
		removeGateHooks();
		restoreAgentDir(prev);
	}
});

test("no gate dir on the ACP argv when the gate is off", async () => {
	assert.equal(gateHooksStaged(), false, "no leftover staging from other tests");
	const run = await runOnce();
	assert.equal(run.outcome.status, "OK");
	assert.ok(run.spawnArgs);
	assert.equal(
		run.spawnArgs!.some((a) => a === "--add-dir"),
		false,
		`the gate dir must not leak into ${JSON.stringify(run.spawnArgs)}`,
	);
});
