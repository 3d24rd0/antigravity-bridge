// Pins for two holes upstream fixed after this fork and we had not:
//   - pi 1.5 blinds an imported keyHint (the import may resolve to another copy
//     of pi-coding-agent), so the expand hint rendered with no key at all;
//   - a refusal returned exitCode 0, so pi drew a success checkmark for a call
//     that never ran.
//
// Run: npm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { askResultErrored, expandHint } from "../src/ask-tool.js";

test("the expand hint comes from the render context when Pi injects one", () => {
	// This is the pi 1.5 path: the host keybindings live in the context.
	const hint = expandHint({ keyHint: () => "x to expand" });
	assert.equal(hint, "x to expand");
});

test("the expand hint falls back to the import when the context has none", () => {
	// pi 1.4 has no context.keyHint; the call must not throw, and it must still
	// produce a suffix for the dim line.
	assert.equal(typeof expandHint(undefined), "string");
	assert.equal(typeof expandHint({}), "string");
});

test("a refusal renders as an error, not as a success", () => {
	const refusal = { exitCode: 0, aborted: false, timedOut: false, empty: false, refused: true };
	assert.equal(askResultErrored(refusal), true);
});

test("a clean run still renders as a success", () => {
	const ok = { exitCode: 0, aborted: false, timedOut: false, empty: false, refused: false };
	assert.equal(askResultErrored(ok), false);
	// The existing failure signals keep working.
	assert.equal(askResultErrored({ ...ok, empty: true }), true);
	assert.equal(askResultErrored({ ...ok, exitCode: 1 }), true);
	assert.equal(askResultErrored({ ...ok, timedOut: true }), true);
});
