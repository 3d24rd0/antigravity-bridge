// Session UI sink: pi invalidates an extension's ctx after newSession, fork,
// switchSession or reload, and from then on the `hasUI` getter and every `ui`
// call throw ("This extension ctx is stale..."). An extension that touches its
// captured ctx from an async callback therefore turns a routine reload into an
// uncaughtException that kills pi. These tests pin that the sink captures the
// decision once and that late notifications can never escape as a throw.

import assert from "node:assert/strict";
import { test } from "vitest";
import { captureUiSink, notifySafely, setStatusSafely, type UiLike } from "../src/session-ui.js";

interface FakeUi extends UiLike {
	notified: Array<{ message: string; level?: string }>;
	statuses: Array<{ key: string; text: string | undefined }>;
}

function fakeUi(overrides: { notifyThrows?: boolean; setStatusThrows?: boolean } = {}): FakeUi {
	const ui: FakeUi = {
		notified: [],
		statuses: [],
		notify(message, level) {
			if (overrides.notifyThrows) throw new Error("This extension ctx is stale after session replacement or reload.");
			ui.notified.push({ message, level });
		},
		setStatus(key, text) {
			if (overrides.setStatusThrows) throw new Error("This extension ctx is stale after session replacement or reload.");
			ui.statuses.push({ key, text });
		},
	};
	return ui;
}

test("notifySafely: forwards the message and reports it landed", () => {
	const ui = fakeUi();
	assert.equal(notifySafely(ui, "bridge started", "warning"), true);
	assert.deepEqual(ui.notified, [{ message: "bridge started", level: "warning" }]);
});

test("notifySafely: a missing UI reports false instead of throwing", () => {
	assert.equal(notifySafely(null, "x"), false);
	assert.equal(notifySafely(undefined, "x"), false);
});

test("notifySafely: a stale UI swallows the throw and reports false", () => {
	const ui = fakeUi({ notifyThrows: true });
	assert.equal(notifySafely(ui, "late warning", "warning"), false);
});

test("setStatusSafely: forwards while live and swallows a stale throw", () => {
	const live = fakeUi();
	assert.equal(setStatusSafely(live, "agy-acp", "downloading"), true);
	assert.deepEqual(live.statuses, [{ key: "agy-acp", text: "downloading" }]);

	const stale = fakeUi({ setStatusThrows: true });
	assert.equal(setStatusSafely(stale, "agy-acp", undefined), false);
});

test("captureUiSink: reads hasUI once and never touches the ctx again", () => {
	let reads = 0;
	const ui = fakeUi();
	const sink = captureUiSink({
		get hasUI() {
			reads += 1;
			return true;
		},
		ui,
	});
	assert.equal(reads, 1);
	assert.equal(sink.available, true);
	assert.equal(sink.notify("one"), true);
	assert.equal(sink.notify("two"), true);
	assert.equal(sink.setStatus("agy-acp", "working"), true);
	assert.equal(reads, 1);
	assert.deepEqual(
		ui.notified.map((n) => n.message),
		["one", "two"],
	);
});

test("captureUiSink: an already-stale ctx yields an unavailable sink, not a throw", () => {
	const sink = captureUiSink({
		get hasUI(): boolean {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
		ui: fakeUi({ notifyThrows: true }),
	});
	assert.equal(sink.available, false);
	assert.equal(sink.notify("late"), false);
	assert.equal(sink.setStatus("agy-acp", undefined), false);
});

test("captureUiSink: the ctx turning stale after capture cannot crash a late notify", () => {
	let stale = false;
	const ui = fakeUi();
	const sink = captureUiSink({
		get hasUI() {
			if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return true;
		},
		ui,
	});
	assert.equal(sink.notify("first"), true);
	stale = true;
	assert.equal(sink.notify("after reload"), true);
	assert.equal(sink.available, true);
});

test("captureUiSink: headless sessions report unavailable so callers keep stderr", () => {
	const sink = captureUiSink({ hasUI: false, ui: fakeUi() });
	assert.equal(sink.available, false);
	assert.equal(sink.notify("headless warning", "warning"), false);
});
