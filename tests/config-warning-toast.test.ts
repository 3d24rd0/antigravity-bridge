// The startup config warning (issue #23): a hand editor never runs /agy, so
// parse fallbacks must surface where they happen. Upstream (fdcec75) runs the
// real extension factory's session_start handlers; this fork's factory loads
// the model catalog (spawning the agy binary) and writes engine-settings files
// under the real HOME at startup, which a test must not perform. The fork
// instead extracts the warning surfacing into entry.ts notifyConfigWarnings()
// and runs THAT against the same captured-UI shape, with a temp agent dir via
// PI_CODING_AGENT_DIR so configPath() resolves inside the sandbox.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notifyConfigWarnings } from "../src/entry.js";
import type { UiSink } from "../src/session-ui.js";

const AGY_ENV_KEYS = [
	"AGY_ASK_TOOL",
	"AGY_WEB_TOOLS",
	"AGY_DIGEST",
	"AGY_SYSTEM_PROMPT",
	"AGY_SKIP_PERMISSIONS",
	"AGY_READONLY",
] as const;

function tempAgentDir(withConfig: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-toast-"));
	// configPath() = <agentDir>/antigravity-bridge/config.json
	fs.mkdirSync(path.join(dir, "antigravity-bridge"), { recursive: true });
	fs.writeFileSync(path.join(dir, "antigravity-bridge", "config.json"), JSON.stringify(withConfig));
	return dir;
}

function capturedUi(notes: string[]): UiSink {
	return {
		available: true,
		notify: (message: string) => {
			notes.push(message);
			return true;
		},
		setStatus: () => true,
	};
}

function withTempAgentDir(withConfig: Record<string, unknown>, run: () => void): void {
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	const prevEnvs = AGY_ENV_KEYS.map((k) => [k, process.env[k]] as const);
	const agentDir = tempAgentDir(withConfig);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const k of AGY_ENV_KEYS) delete process.env[k];
	try {
		run();
	} finally {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		for (const [k, prev] of prevEnvs) {
			if (prev === undefined) delete process.env[k];
			else process.env[k] = prev;
		}
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

test("toast: junk config booleans warn on startup with the doctor pointer", () => {
	withTempAgentDir({ skipPermissions: "banana" }, () => {
		const notes: string[] = [];
		notifyConfigWarnings(capturedUi(notes));
		assert.ok(
			notes.some((n) => /config\.json/.test(n) && /unparseable/.test(n) && /\/agy doctor/.test(n)),
			`expected a config warning toast, got: ${JSON.stringify(notes)}`,
		);
	});
});

test("toast: a clean config emits no config warning", () => {
	withTempAgentDir({}, () => {
		const notes: string[] = [];
		notifyConfigWarnings(capturedUi(notes));
		assert.ok(
			!notes.some((n) => /config\.json/.test(n) && /unparseable/.test(n)),
			`clean config must not warn, got: ${JSON.stringify(notes)}`,
		);
	});
});
