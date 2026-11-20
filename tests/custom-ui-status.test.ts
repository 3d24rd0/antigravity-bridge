import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { showArtifactsBrowser } from "../src/artifacts-ui.js";
import type { AgyArtifact } from "../src/artifacts.js";
import { showTasksBrowser } from "../src/tasks-ui.js";
import type { AgyTask } from "../src/tasks.js";
import { showSettingsMenu, showChoiceMenu } from "../src/settings-menu.js";

function capture() {
	let view: { handleInput(data: string): void } | undefined;
	const options: Array<{ blocked?: unknown }> = [];
	const ui = {
		custom: (factory: (host: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown, opts: { blocked?: unknown }) => {
			options.push(opts);
			return new Promise<unknown>((resolve) => {
				view = factory({ requestRender() {}, terminal: { rows: 24 } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, undefined, resolve) as typeof view;
			});
		},
	} as unknown as ExtensionUIContext;
	return { ui, options, input: (key: string) => { assert.ok(view); view.handleInput(key); } };
}

test("settings status is supplied on every open and Escape closes", async () => {
	const fake = capture();
	for (let i = 0; i < 2; i++) {
		const pending = showSettingsMenu(fake.ui, { title: "Settings", rows: [{ id: "x", label: "X", currentValue: "a", values: ["a", "b"] }], onChange: () => {} });
		fake.input("\x1b");
		assert.equal(await pending, undefined);
	}
	assert.deepEqual(fake.options.map((o) => o.blocked), Array(2).fill({ kind: "question", message: "Antigravity provider settings" }));
});

test("choice status uses its actual title on selection and reopening", async () => {
	const fake = capture();
	for (const key of ["\r", "\x1b"]) {
		const pending = showChoiceMenu(fake.ui, { title: "Another choice", options: [{ value: "a", label: "A" }] });
		fake.input(key);
		assert.equal(await pending, key === "\r" ? "a" : undefined);
	}
	assert.deepEqual(fake.options.map((o) => o.blocked), Array(2).fill({ kind: "question", message: "Another choice" }));
});

test("artifact status accompanies rescan, reopen, selection and cancellation", async () => {
	const fake = capture();
	const artifact: AgyArtifact = { name: "a.txt", absolutePath: "/tmp/a.txt", kind: "conversation", mediaType: "text", bytes: 1, modifiedMs: 0 };
	for (const [key, expected] of [["r", { type: "rescan" }], ["\r", { type: "open", artifact }], ["\x1b", { type: "close" }]] as const) {
		const pending = showArtifactsBrowser(fake.ui, [artifact]);
		fake.input(key);
		assert.deepEqual(await pending, expected);
	}
	assert.deepEqual(fake.options.map((o) => o.blocked), Array(3).fill({ kind: "question", message: "Choose an Antigravity artifact" }));
});

test("task status accompanies rescan, reopen, selection and cancellation", async () => {
	const fake = capture();
	const task: AgyTask = { id: 1, logPath: "/tmp/task-1.log", bytes: 1, modifiedMs: 0, active: false, livenessKnown: true };
	for (const [key, expected] of [["r", { type: "rescan" }], ["\r", { type: "close" }], ["\x1b", { type: "close" }]] as const) {
		const pending = showTasksBrowser(fake.ui, [task], true);
		fake.input(key);
		assert.deepEqual(await pending, expected);
	}
	assert.deepEqual(fake.options.map((o) => o.blocked), Array(3).fill({ kind: "question", message: "Choose an Antigravity task" }));
});
