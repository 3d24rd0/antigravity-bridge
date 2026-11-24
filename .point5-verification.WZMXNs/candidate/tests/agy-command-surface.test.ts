// /agy command surface (audit 2026-11): the help text and Tab completion come
// from one table, so the documented usage cannot drift from the dispatcher.
//
// Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import { AGY_SUBCOMMANDS, agyArgumentCompletions, agyUsageLine } from "../src/agy-command-surface.js";

test("every subcommand is documented and uniquely named", () => {
	const names = AGY_SUBCOMMANDS.map((sub) => sub.name);
	assert.equal(new Set(names).size, names.length, "duplicate subcommand name");
	for (const sub of AGY_SUBCOMMANDS) {
		assert.ok(sub.description.trim().length > 0, `${sub.name} needs a description`);
		assert.ok(sub.usage.startsWith(sub.name), `${sub.name} usage must start with the name`);
	}
});

test("the usage line lists every visible subcommand and hides the retired one", () => {
	const usage = agyUsageLine();
	for (const sub of AGY_SUBCOMMANDS) {
		if (sub.hidden) continue;
		assert.ok(usage.includes(sub.name), `${sub.name} missing from the usage line`);
	}
	assert.ok(!usage.includes("status"), "the retired status command must not be advertised");
	// The stale claim that started this: /agy engine no longer switches anything.
	assert.ok(!usage.includes("engine stream-json"), "engine must not advertise values it ignores");
});

test("completion offers subcommand names filtered by prefix", () => {
	const all = agyArgumentCompletions("");
	assert.equal(all.length, AGY_SUBCOMMANDS.filter((sub) => !sub.hidden).length);
	assert.deepEqual(
		agyArgumentCompletions("do").map((item) => item.value),
		["doctor"],
	);
	assert.deepEqual(
		agyArgumentCompletions("auth").map((item) => item.value),
		["auth", "auth-manual"],
	);
	assert.ok(
		all.every((item) => item.description && item.description.length > 0),
		"completions must carry a description",
	);
	assert.deepEqual(agyArgumentCompletions("stat"), [], "the retired status is not suggested");
});

test("completion offers the closed value set of the selected subcommand", () => {
	assert.deepEqual(
		agyArgumentCompletions("mode ").map((item) => item.value),
		["accept-edits", "plan"],
	);
	assert.deepEqual(
		agyArgumentCompletions("mode p").map((item) => item.value),
		["plan"],
	);
	assert.deepEqual(
		agyArgumentCompletions("/agy bridge ").map((item) => item.value),
		["all", "mcp", "none"],
	);
	assert.deepEqual(
		agyArgumentCompletions("tools r").map((item) => item.value),
		["reset"],
	);
	// Free-form arguments complete nothing rather than guessing.
	assert.deepEqual(agyArgumentCompletions("model "), []);
	assert.deepEqual(agyArgumentCompletions("acp-bin /usr/local/bin/x"), []);
});

test("/agy thinking offers agy's tier vocabulary, without a tier no model has", () => {
	const thinking = AGY_SUBCOMMANDS.find((sub) => sub.name === "thinking");
	assert.ok(thinking);
	assert.deepEqual(thinking.values, ["low", "medium", "high", "xhigh"]);
	assert.equal(thinking.usage, "thinking low|medium|high|xhigh");
	assert.ok(agyUsageLine().includes("thinking low|medium|high|xhigh"));
	assert.deepEqual(
		agyArgumentCompletions("thinking x").map((item) => item.value),
		["xhigh"],
	);
});

test("the retired engine subcommand is gone, not just unadvertised", () => {
	// It printed "engine is chosen by the model name" and changed nothing, while
	// /agy auth told users to run it. A command that cannot do anything must not
	// exist in the surface.
	assert.equal(AGY_SUBCOMMANDS.some((sub) => sub.name === "engine"), false);
	assert.deepEqual(agyArgumentCompletions("en"), []);
});

test("acp-update is advertised and completes", () => {
	const sub = AGY_SUBCOMMANDS.find((s) => s.name === "acp-update");
	assert.ok(sub);
	assert.ok(agyArgumentCompletions("acp-").some((item) => item.value === "acp-update"));
	assert.ok(agyArgumentCompletions("acp-").some((item) => item.value === "acp-bin"));
});
