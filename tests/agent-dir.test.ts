// Issue #17 port (upstream 8dee43b): every bridge-owned path must follow pi's
// agent-dir resolution. These tests pin the PRODUCTION default path by setting
// PI_CODING_AGENT_DIR (what getAgentDir() reads) — no override params — and
// asserting each helper resolves under the relocated dir. Vanilla defaults
// (~/.pi/agent) are byte-identical to the pre-fix hardcoded paths, so they are
// not re-pinned here; the shape tests in the per-module suites cover layouts.

// Fork shape notes vs upstream:
//   - extensionsDataDir() is intentionally not adopted (no extensions-data
//     consumer in this fork); logsDir() keeps our bridge-data location.
//   - suppressionMarkerPath() keeps OUR bridgeDir() location (upstream's sat
//     under extensions-data both before and after 8dee43b).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { bridgeDir, bridgeDataDir, configPath, defaultConfigPath, logsDir } from "../src/config.js";
import { suppressionMarkerPath } from "../src/mcp-registration.js";
import { patchBackupDir } from "../src/patch-cleanup.js";
import { bridgeMcpConfigDir } from "../src/mcp-server.js";

test("PI_CODING_AGENT_DIR relocates every bridge-owned path (issue #17)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agentdir-"));
	const agentDir = path.join(root, ".gentle-shell", "agent");
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.equal(bridgeDir(), path.join(agentDir, "antigravity-bridge"));
		assert.equal(bridgeDataDir(), path.join(agentDir, "antigravity-bridge"), "bridgeDataDir stays a thin bridgeDir wrapper");
		assert.equal(configPath(), path.join(agentDir, "antigravity-bridge", "config.json"));
		assert.equal(defaultConfigPath(), path.join(agentDir, "antigravity-bridge", "config.json"));
		assert.equal(patchBackupDir(), path.join(agentDir, "antigravity-bridge", "pi-patch-backup"));
		assert.equal(bridgeMcpConfigDir(), path.join(agentDir, "antigravity-bridge", `agy-mcp-${process.pid}`));

		// Fork shape: logs and the suppression marker live under the bridge
		// data dir (upstream relocated logs+marker to extensions-data; our
		// user data stays where it is, only the root relocates).
		assert.equal(logsDir(), path.join(agentDir, "antigravity-bridge", "logs"));
		assert.equal(suppressionMarkerPath(), path.join(agentDir, "antigravity-bridge", "suppression.json"));
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("path helpers keep taking explicit agentDir injection (upstream seam)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-agentdir-inject-"));
	const agentDir = path.join(root, "other", "agent");
	try {
		assert.equal(bridgeDir(agentDir), path.join(agentDir, "antigravity-bridge"));
		assert.equal(configPath(agentDir), path.join(agentDir, "antigravity-bridge", "config.json"));
		assert.equal(logsDir(agentDir), path.join(agentDir, "antigravity-bridge", "logs"));
		assert.equal(suppressionMarkerPath(agentDir), path.join(agentDir, "antigravity-bridge", "suppression.json"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
