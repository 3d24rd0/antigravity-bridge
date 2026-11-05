// SessionStore write serialization regressions (audit 2026-11).
//
// persist() merges the dirty keys, awaits writeFile + rename, and only then
// cleared its bookkeeping. A set()/delete() landing inside those awaits was
// tracked and then silently untracked, so the queued second write found an
// empty dirty set and wrote the pre-mutation snapshot.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { SessionStore } from "../src/sessions.js";

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-sess-race-")), "sessions.json");
}

function readStore(file: string): Record<string, { conversationId: string }> {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { conversationId: string }>;
}

/** Replace fs.promises.rename for the duration of `run`, calling `during` once
 *  while the first write is in flight (after its merge, before its rename). */
async function whileWriting(during: () => void, run: () => Promise<void>): Promise<void> {
	const realRename = fs.promises.rename;
	let injected = false;
	fs.promises.rename = async (from: fs.PathLike, to: fs.PathLike) => {
		if (!injected) {
			injected = true;
			during();
		}
		return realRename(from, to);
	};
	try {
		await run();
	} finally {
		fs.promises.rename = realRename;
	}
}

test("persist keeps a set() that lands while the write is in flight", async () => {
	const file = tmpStorePath();
	const store = new SessionStore(file);
	await whileWriting(
		() => store.set("b", { conversationId: "conv-b", lastStepIdx: -1, lastMessageCount: 0 }),
		async () => {
			store.set("a", { conversationId: "conv-a", lastStepIdx: -1, lastMessageCount: 0 });
			await store.flush();
			await store.flush();
		},
	);
	const disk = readStore(file);
	assert.equal(disk.a?.conversationId, "conv-a");
	assert.equal(disk.b?.conversationId, "conv-b", "the mid-write mutation must reach disk");
});

test("persist keeps a delete() that lands while the write is in flight", async () => {
	const file = tmpStorePath();
	const store = new SessionStore(file);
	store.set("b", { conversationId: "conv-b", lastStepIdx: -1, lastMessageCount: 0 });
	await store.flush();

	await whileWriting(
		() => store.delete("b"),
		async () => {
			store.set("a", { conversationId: "conv-a", lastStepIdx: -1, lastMessageCount: 0 });
			await store.flush();
			await store.flush();
		},
	);
	const disk = readStore(file);
	assert.equal(disk.a?.conversationId, "conv-a");
	assert.equal(disk.b, undefined, "the mid-write deletion must reach disk");
});
