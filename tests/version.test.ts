// The MCP handshake announced a hardcoded "1.0.0", so every later release would
// have told each MCP client the wrong version. These pin the wiring instead of
// the current number, so a bump needs no test edit.
//
// Run: npm test

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bridgeVersion } from "../src/version.js";

test("the reported version is the package version", () => {
	const pkg = JSON.parse(
		fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { version: string };
	assert.equal(bridgeVersion(), pkg.version);
});

test("the reported version looks like a release version", () => {
	assert.match(bridgeVersion(), /^\d+\.\d+\.\d+/);
});
