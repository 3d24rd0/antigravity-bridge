// The engine settings files belong to the user (the CLI one carries permissions,
// trusted workspaces and the chosen model), so the bridge may only add one key,
// atomically, and must never rewrite a file it cannot parse.
//
// Run: npm test

import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { engineSettingsPaths, ensureSendImmediately } from "../src/engine-settings.js";

let dir = "";
let file = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-settings-"));
	file = path.join(dir, "settings.json");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing settings file is created with the key", () => {
	const target = path.join(dir, "nested", "settings.json");
	assert.equal(ensureSendImmediately(target), "written");
	assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { queuedMessages: "send-immediately" });
});

test("the key is added without disturbing the rest of the file", () => {
	fs.writeFileSync(
		file,
		JSON.stringify({ model: "flash", permissions: { allow: ["command(echo)"] }, trustedWorkspaces: ["/x"] }),
	);
	assert.equal(ensureSendImmediately(file), "written");
	const after = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(after.queuedMessages, "send-immediately");
	assert.equal(after.model, "flash");
	assert.deepEqual(after.permissions, { allow: ["command(echo)"] });
	assert.deepEqual(after.trustedWorkspaces, ["/x"]);
});

test("an explicit user value wins, including the default", () => {
	fs.writeFileSync(file, JSON.stringify({ queuedMessages: "queue" }));
	assert.equal(ensureSendImmediately(file), "already-set");
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).queuedMessages, "queue");
});

test("an unparseable file is never touched", () => {
	const original = '{ "model": "flash",, }';
	fs.writeFileSync(file, original);
	assert.equal(ensureSendImmediately(file), "unreadable");
	assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("a non-object document is never touched", () => {
	for (const original of ["[]", "null", "42", '"text"']) {
		fs.writeFileSync(file, original);
		assert.equal(ensureSendImmediately(file), "unreadable", `for ${original}`);
		assert.equal(fs.readFileSync(file, "utf8"), original);
	}
});

test("both engine paths are covered", () => {
	const paths = engineSettingsPaths("/home/x");
	assert.deepEqual(paths, [
		path.join("/home/x", ".gemini", "antigravity-cli", "settings.json"),
		path.join("/home/x", ".gemini", "antigravity-acp", "settings.json"),
	]);
});
