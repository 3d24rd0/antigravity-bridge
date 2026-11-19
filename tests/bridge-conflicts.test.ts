// Pins for conflicting Antigravity bridge/auth detection (S5).
//
// /agy doctor must warn when another Antigravity bridge or auth package is
// configured next to this one: two bridges fight over the same provider ids
// and the same Google account, and the user sees random failures instead of
// a diagnosis. The scan is best effort (missing or corrupt settings files are
// normal) and never flags this package itself.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
	KNOWN_CONFLICTING_BRIDGES,
	detectConflictingAntigravityBridges,
	formatBridgeConflictWarning,
} from "../src/bridge-conflicts.js";

const scratch: string[] = [];

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bridge-conflicts-"));
	scratch.push(dir);
	return dir;
}

function writeSettings(file: string, packages: unknown): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ packages }));
	return file;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// --- detection ---------------------------------------------------------------

test("the known conflicting list carries both bridges and auth packages", () => {
	for (const name of [
		"pi-antigravity",
		"@cortexkit/pi-antigravity-auth",
		"@estebanforge/pi-antigravity-bridge",
		"pi-antigravity-auth",
	]) {
		assert.ok((KNOWN_CONFLICTING_BRIDGES as readonly string[]).includes(name), `${name} must be known`);
	}
});

test("detects a conflicting bridge in the Pi agent settings", () => {
	const home = tmpDir();
	writeSettings(path.join(home, ".pi", "agent", "settings.json"), [
		"npm:pi-antigravity@1.2.3",
		"npm:@some/other-package@1.0.0",
	]);
	const hits = detectConflictingAntigravityBridges({ home, agentDir: "" });
	assert.equal(hits.length, 1);
	assert.equal(hits[0].name, "pi-antigravity");
	assert.equal(hits[0].source, "npm:pi-antigravity@1.2.3");
	assert.equal(hits[0].file, path.join(home, ".pi", "agent", "settings.json"));
});

test("detects conflicting bridges in the Gentle Shell settings", () => {
	const home = tmpDir();
	writeSettings(path.join(home, ".gentle-shell", "agent", "settings.json"), [
		"npm:@cortexkit/pi-antigravity-auth@0.4.0",
	]);
	writeSettings(path.join(home, ".gentle-shell", "settings.json"), [
		"npm:@estebanforge/pi-antigravity-bridge@0.3.0",
	]);
	const hits = detectConflictingAntigravityBridges({ home, agentDir: "" });
	assert.deepEqual(
		hits.map((h) => h.name).sort(),
		["@cortexkit/pi-antigravity-auth", "@estebanforge/pi-antigravity-bridge"],
	);
	assert.ok(hits.some((h) => h.file === path.join(home, ".gentle-shell", "settings.json")));
});

test("detects a conflicting bridge in the project settings", () => {
	const home = tmpDir();
	const cwd = tmpDir();
	writeSettings(path.join(cwd, ".pi", "settings.json"), ["pi-antigravity-auth"]);
	const hits = detectConflictingAntigravityBridges({ home, cwd, agentDir: "" });
	assert.deepEqual(
		hits.map((h) => h.name),
		["pi-antigravity-auth"],
	);
});

test("detects an unlisted scoped variant through the agentDir override", () => {
	const home = tmpDir();
	const agentDir = tmpDir();
	writeSettings(path.join(agentDir, "settings.json"), ["npm:@someoneelse/pi-antigravity@2.0.0"]);
	const hits = detectConflictingAntigravityBridges({ home, agentDir });
	assert.deepEqual(
		hits.map((h) => h.name),
		["@someoneelse/pi-antigravity"],
	);
});

test("detects object package entries through their source field", () => {
	const home = tmpDir();
	writeSettings(path.join(home, ".pi", "agent", "settings.json"), [
		{ source: "npm:pi-antigravity-auth@2.0.0" },
		{ source: "npm:@3d24rd0/pi-antigravity-bridge@1.4.1" },
	]);
	const hits = detectConflictingAntigravityBridges({ home, agentDir: "" });
	assert.deepEqual(
		hits.map((h) => h.name),
		["pi-antigravity-auth"],
	);
	assert.equal(hits[0].source, "npm:pi-antigravity-auth@2.0.0");
});

test("detects git specifiers and local checkouts of another bridge", () => {
	const home = tmpDir();
	writeSettings(path.join(home, ".pi", "agent", "settings.json"), [
		"git:https://github.com/someone/pi-antigravity",
		"/opt/checkouts/pi-antigravity-auth",
	]);
	const hits = detectConflictingAntigravityBridges({ home, agentDir: "" });
	assert.deepEqual(
		hits.map((h) => h.name),
		["pi-antigravity", "pi-antigravity-auth"],
	);
});

test("never flags this package, whatever the specifier shape", () => {
	const home = tmpDir();
	writeSettings(path.join(home, ".pi", "agent", "settings.json"), [
		"npm:@3d24rd0/pi-antigravity-bridge@1.4.1",
		"@3d24rd0/pi-antigravity-bridge",
		"npm:pi-antigravity-bridge@1.4.1",
		"pi-antigravity-bridge",
		{ source: "npm:@3d24rd0/pi-antigravity-bridge" },
		"~/code/pi-extensions",
		"/home/dev/checkouts/pi-antigravity-bridge",
		"./pi-extensions",
	]);
	assert.deepEqual(detectConflictingAntigravityBridges({ home, agentDir: "" }), []);
});

test("package-name boundaries keep lookalikes quiet", () => {
	const home = tmpDir();
	writeSettings(path.join(home, ".pi", "agent", "settings.json"), [
		"my-pi-antigravity-notes",
		"my-pi-antigravity-helper",
		"npm:pi-antigravity-bridge-extra@1.0.0",
		"npm:@3d24rd0/pi-antigravity-bridge-extras@1.0.0",
		"pi-gravity",
	]);
	assert.deepEqual(detectConflictingAntigravityBridges({ home, agentDir: "" }), []);
});

test("a clean install has no conflicts", () => {
	const home = tmpDir();
	assert.deepEqual(detectConflictingAntigravityBridges({ home, agentDir: "" }), []);
});

test("missing, corrupt, and non-array packages are tolerated", () => {
	const home = tmpDir();
	const corrupt = path.join(home, ".pi", "agent", "settings.json");
	fs.mkdirSync(path.dirname(corrupt), { recursive: true });
	fs.writeFileSync(corrupt, '{"packages": [');
	const nonArray = path.join(home, ".gentle-shell", "settings.json");
	fs.mkdirSync(path.dirname(nonArray), { recursive: true });
	fs.writeFileSync(nonArray, JSON.stringify({ packages: "npm:pi-antigravity@1.0.0" }));
	const arrayFile = path.join(home, ".gentle-shell", "agent", "settings.json");
	fs.mkdirSync(path.dirname(arrayFile), { recursive: true });
	fs.writeFileSync(arrayFile, JSON.stringify({ packages: [42, null, { source: 7 }, ""] }));
	assert.deepEqual(detectConflictingAntigravityBridges({ home, agentDir: "" }), []);
});

test("explicit settings files are scanned and never double-counted", () => {
	const home = tmpDir();
	const defaultFile = writeSettings(path.join(home, ".pi", "agent", "settings.json"), ["pi-antigravity"]);
	const extra = writeSettings(path.join(home, "elsewhere", "settings.json"), ["pi-antigravity-auth"]);
	const hits = detectConflictingAntigravityBridges({ home, agentDir: "", settingsFiles: [defaultFile, extra] });
	assert.deepEqual(
		hits.map((h) => `${h.name}@${path.relative(home, h.file)}`).sort(),
		["pi-antigravity-auth@elsewhere/settings.json", "pi-antigravity@.pi/agent/settings.json"],
	);
});

test("repeated entries collapse into one hit per name and file", () => {
	const home = tmpDir();
	writeSettings(path.join(home, ".pi", "agent", "settings.json"), [
		"npm:pi-antigravity@1.0.0",
		"pi-antigravity",
		{ source: "npm:pi-antigravity@1.0.0" },
	]);
	const hits = detectConflictingAntigravityBridges({ home, agentDir: "" });
	assert.equal(hits.length, 1);
});

test("a home-scoped scan never reads the developer's PI_CODING_AGENT_DIR", () => {
	const home = tmpDir();
	const agentDir = tmpDir();
	writeSettings(path.join(agentDir, "settings.json"), ["pi-antigravity"]);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.deepEqual(detectConflictingAntigravityBridges({ home, agentDir: "" }), []);
		assert.equal(detectConflictingAntigravityBridges({ home, agentDir }).length, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

// --- formatting --------------------------------------------------------------

test("the warning formatter stays silent without hits", () => {
	assert.equal(formatBridgeConflictWarning([]), undefined);
});

test("the warning formatter names the packages, files, and the keeper", () => {
	const warning = formatBridgeConflictWarning([
		{ name: "pi-antigravity", source: "npm:pi-antigravity@1.0.0", file: "/home/dev/.pi/agent/settings.json" },
		{ name: "@cortexkit/pi-antigravity-auth", source: "npm:@cortexkit/pi-antigravity-auth@0.1.0", file: "/repo/.pi/settings.json" },
	]);
	assert.ok(warning !== undefined);
	assert.match(warning, /pi-antigravity \(/);
	assert.match(warning, /@cortexkit\/pi-antigravity-auth/);
	assert.match(warning, /\/home\/dev\/\.pi\/agent\/settings\.json/);
	assert.match(warning, /\/repo\/\.pi\/settings\.json/);
	assert.match(warning, /@3d24rd0\/pi-antigravity-bridge/);
});
