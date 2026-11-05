// Antigravity echoes its own <SYSTEM_MESSAGE> notifications back as assistant
// text. The block can be split across any number of streamed deltas, so the
// filter has to be stateful and must never eat real text.
//
// Run: npm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { SystemMessageSanitizer } from "../src/stream-sanitizer.js";

const OPEN = "<SYSTEM_MESSAGE>";
const CLOSE = "</SYSTEM_MESSAGE>";

function run(chunks: string[]): string {
	const sanitizer = new SystemMessageSanitizer();
	let out = "";
	for (const chunk of chunks) out += sanitizer.push(chunk);
	return out + sanitizer.flush();
}

test("plain text passes through untouched", () => {
	assert.equal(run(["hello", " world"]), "hello world");
	assert.equal(run(["no markup here at all"]), "no markup here at all");
});

test("a complete block in one chunk is removed, the surrounding text kept", () => {
	const text = `before ${OPEN}Background task finished.${CLOSE} after`;
	assert.equal(run([text]), "before  after");
});

test("a block split across many deltas is removed without leaking fragments", () => {
	const text = `Answer: ${OPEN}job 42 done${CLOSE} done.`;
	const chunks = text.split("");
	assert.equal(run(chunks), "Answer:  done.");
});

test("a partial marker that never becomes the tag is emitted, not swallowed", () => {
	assert.equal(run(["<SYS", "pancake"]), "<SYSpancake");
	assert.equal(run(["a <SYSTEM", " not really"]), "a <SYSTEM not really");
});

test("a block that never closes is flushed at EOF instead of losing text", () => {
	assert.equal(run([`kept ${OPEN}no close at all`]), `kept ${OPEN}no close at all`);
});

test("multiple blocks are all removed", () => {
	const text = `a${OPEN}1${CLOSE}b${OPEN}2${CLOSE}c`;
	assert.equal(run([text]), "abc");
	// ... including when they arrive split.
	assert.equal(run(text.split("")), "abc");
});

test("text after a block in the same delta is not dropped", () => {
	const sanitizer = new SystemMessageSanitizer();
	const out = sanitizer.push(`${OPEN}note${CLOSE}the real answer`);
	assert.equal(out, "the real answer");
	assert.equal(sanitizer.flush(), "");
});

test("a block that grows past the cap is released instead of swallowing text", () => {
	// An unterminated block must not buffer forever: past the cap it is emitted
	// verbatim, marker included.
	const sanitizer = new SystemMessageSanitizer({ maxHeld: 10 });
	const out = sanitizer.push(`a${OPEN}${"x".repeat(40)}`);
	assert.equal(out, `a${OPEN}${"x".repeat(40)}`);
	assert.equal(sanitizer.flush(), "");
});
