// Audit hygiene regressions (2026-11).
//
// S8: duplicate permission option labels stay distinguishable.
// S9: settled approval tickets nobody polls are swept after a TTL.
// S10: a Windows install is found through PATHEXT; POSIX behavior unchanged.
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

test("S10 a .cmd install is found on Windows through PATHEXT", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-win-"));
	fs.writeFileSync(path.join(dir, "agy.cmd"), "@echo off\n");

	assert.equal(isAgyInstalled("agy", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"), true);
	assert.equal(isAgyInstalled("agy", { PATH: dir, PATHEXT: ".EXE" }, "win32"), false);
	// POSIX never guesses extensions: an extensionless binary must exist as-is.
	assert.equal(isAgyInstalled("agy", { PATH: dir }, "darwin"), false);
	// An explicit path keeps working on every platform.
	assert.equal(isAgyInstalled(path.join(dir, "agy.cmd"), {}, "darwin"), true);
});

test("S10b a dotted Windows name still tries PATHEXT", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-win-dot-"));
	fs.writeFileSync(path.join(dir, "agy.v2.cmd"), "@echo off\n");
	// A dot in the bare name is not proof of an explicit extension: only a
	// PATHEXT suffix is.
	assert.equal(isAgyInstalled("agy.v2", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"), true);

	fs.writeFileSync(path.join(dir, "agy.exe"), "");
	assert.equal(isAgyInstalled("agy.exe", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"), true);
});
