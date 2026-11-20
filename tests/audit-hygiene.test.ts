// Audit hygiene regressions (2026-11).
//
// S8: duplicate permission option labels stay distinguishable.
// S9: settled approval tickets nobody polls are swept after a TTL.
// S10: Windows detection matches shell-free .exe spawning; POSIX stays extensionless.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { distinctLabels } from "../src/permission-labels.js";
import { PARK_SWEEP_TTL_MS, sweepSettledParks, type ParkEntry } from "../src/mcp-server.js";
import { isAgyInstalled } from "../src/engine-picker.js";

test("S8 duplicate permission labels stay distinguishable", () => {
	assert.deepEqual(distinctLabels(["Allow", "Allow", "Reject"]), ["Allow", "Allow (2)", "Reject"]);
	assert.deepEqual(distinctLabels(["Allow", "Allow", "Allow"]), ["Allow", "Allow (2)", "Allow (3)"]);
	assert.deepEqual(distinctLabels(["Read", "Write"]), ["Read", "Write"], "no change when labels are unique");
});

test("S8b generated suffixes never collide with a literal or another suffix", () => {
	// A literal that already looks like a generated suffix must stay verbatim,
	// so the repeat has to skip past it.
	assert.deepEqual(distinctLabels(["Allow", "Allow", "Allow (2)"]), ["Allow", "Allow (3)", "Allow (2)"]);
	// A generated suffix must not steal a later literal's exact text.
	assert.deepEqual(distinctLabels(["Allow", "Allow (2)", "Allow"]), ["Allow", "Allow (2)", "Allow (3)"]);
	assert.deepEqual(distinctLabels(["Allow (2)", "Allow (2)"]), ["Allow (2)", "Allow (2) (2)"]);
});

test("S8c every output label is unique and position-preserving for any input", () => {
	const cases: string[][] = [
		[],
		["Read", "Write"],
		["Allow", "Allow", "Allow (2)"],
		["Allow", "Allow (2)", "Allow"],
		["Allow (2)", "Allow (2)"],
		["Allow (3)", "Allow", "Allow", "Allow (2)", "Allow"],
		["Allow", "Allow (2)", "Allow (3)", "Allow"],
	];
	for (const input of cases) {
		const output = distinctLabels(input);
		assert.equal(output.length, input.length, `length preserved for ${JSON.stringify(input)}`);
		assert.equal(
			new Set(output).size,
			output.length,
			`labels must be unique for ${JSON.stringify(input)} -> ${JSON.stringify(output)}`,
		);
		// A label keeps its own text whenever that text is still free.
		input.forEach((label, i) => {
			if (input.indexOf(label) === i) assert.equal(output[i], label);
		});
	}
});

test("S9 only settled parks older than the TTL are swept", () => {
	const now = 1_000_000;
	const entry = (name: string, terminalAt?: number): ParkEntry => ({
		name,
		since: now - PARK_SWEEP_TTL_MS * 2,
		timer: setTimeout(() => {}, 0),
		...(terminalAt === undefined ? {} : { terminal: { allow: false as const, reason: "test" }, terminalAt }),
	});
	const parks = new Map<string, ParkEntry>([
		["settled-old", entry("a", now - PARK_SWEEP_TTL_MS - 1)],
		["settled-new", entry("b", now - 1000)],
		["pending", entry("c")],
	]);
	assert.equal(sweepSettledParks(parks, now), 1);
	assert.deepEqual([...parks.keys()].sort(), ["pending", "settled-new"]);
});

test.each(["cmd", "bat", "CMD", "BAT", "com"])("S10 Windows rejects .%s shims, including explicit paths", (ext) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-win-"));
	try {
		const name = `agy.${ext}`;
		const file = path.join(dir, name);
		fs.writeFileSync(file, "@echo off\n");
		const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
		assert.equal(isAgyInstalled("agy", env, "win32"), false);
		assert.equal(isAgyInstalled(name, env, "win32"), false);
		assert.equal(isAgyInstalled(file, env, "win32"), false);
		assert.equal(isAgyInstalled("agy", env, "darwin"), false);
		assert.equal(isAgyInstalled(file, env, "darwin"), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test.each(["exe", "EXE"])("S10b Windows finds dotted names and explicit .%s without relying on PATHEXT", (ext) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-win-dot-"));
	try {
		fs.writeFileSync(path.join(dir, `agy.v2.${ext}`), "");
		const env = { PATH: dir, PATHEXT: ".BAT;.CMD" };
		assert.equal(isAgyInstalled("agy.v2", env, "win32"), true);
		const file = path.join(dir, `agy.${ext}`);
		fs.writeFileSync(file, "");
		assert.equal(isAgyInstalled("agy", env, "win32"), true);
		assert.equal(isAgyInstalled(`agy.${ext}`, env, "win32"), true);
		assert.equal(isAgyInstalled(file, env, "win32"), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("S10c Windows searches multiple PATH directories separated by semicolons", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-win-path-"));
	try {
		fs.writeFileSync(path.join(dir, "agy.exe"), "");
		assert.equal(isAgyInstalled("agy", { PATH: `${path.join(dir, "missing")};${dir}` }, "win32"), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("S10d POSIX treats a backslash as part of a bare filename", () => {
	if (process.platform === "win32") return;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-posix-"));
	try {
		fs.writeFileSync(path.join(dir, "agy\\v2"), "");
		assert.equal(isAgyInstalled("agy\\v2", { PATH: dir }, "darwin"), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
