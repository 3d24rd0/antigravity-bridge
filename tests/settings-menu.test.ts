// Settings surface regressions (audit 2026-11, dialog-kit replacement).
//
// The /agy menu used to come from @estebanforge/pi-tui-dialogs. It is now
// built on pi-tui's own SettingsList/SelectList, so these tests pin the two
// things a rendering change could silently break: the row/id -> config mapping
// (a wrong branch writes the wrong key) and the frame the user actually sees.
//
// Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { applySettingChange } from "../src/commands.js";
import {
	buildChoiceItems,
	buildMenuItems,
	MENU_FOOTER,
	showChoiceMenu,
	showSettingsMenu,
	type MenuRow,
} from "../src/settings-menu.js";

/** Identity theme: fg(color, text) -> text keeps assertions ANSI-free. */
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;

/** Capture the component the surface builds, let the test render it, then
 *  resolve the dialog the way Esc/confirm would. */
function fakeUi<T>(result: T) {
	let resolveDone!: (value: T) => void;
	const settled = new Promise<T>((resolve) => (resolveDone = resolve));
	let component: Component | undefined;
	const ui = {
		custom: (factory: (t: TUI, th: Theme, kb: unknown, done: (value: T) => void) => Component) => {
			component = factory(tui, theme, {}, (value: T) => resolveDone(value));
			return settled;
		},
	} as unknown as ExtensionUIContext;
	return {
		ui,
		render: (width = 90): string => {
			assert.ok(component, "the surface must build a component synchronously");
			return component.render(width).join("\n");
		},
		finish: () => resolveDone(result),
		settled,
	};
}

const rows: MenuRow[] = [
	{
		id: "mode",
		label: "Execution mode",
		description: "accept-edits applies directly; plan refuses.",
		currentValue: "accept-edits",
		values: ["accept-edits", "plan"],
	},
	{ id: "digest", label: "Context digest", currentValue: "off", values: ["on", "off"] },
];

test("menu rows: validated before any overlay opens", () => {
	assert.equal(buildMenuItems(rows).length, 2);
	assert.throws(() => buildMenuItems([rows[0]!, rows[0]!]), /duplicate settings row id/);
	assert.throws(() => buildMenuItems([{ id: "x", label: "X", currentValue: "a", values: [] }]), /needs at least one value/);
	assert.throws(
		() => buildMenuItems([{ id: "x", label: "X", currentValue: "c", values: ["a", "b"] }]),
		/current value "c" is not one of/,
	);
});

test("settings menu: frame carries title, subtitle, rows and footer", async () => {
	const fake = fakeUi<void>(undefined);
	const seen: Array<[string, string]> = [];
	const pending = showSettingsMenu(fake.ui, {
		title: "Antigravity provider",
		subtitle: "Config file: /tmp/agy.json",
		rows,
		onChange: (id, value) => seen.push([id, value]),
	});
	const text = fake.render(90);
	assert.match(text, /Antigravity provider/);
	assert.match(text, /Config file: \/tmp\/agy\.json/);
	assert.match(text, /Execution mode/);
	assert.match(text, /accept-edits/);
	assert.ok(text.includes(MENU_FOOTER), "the footer hint must be rendered");
	fake.finish();
	await pending;
	assert.deepEqual(seen, [], "closing without a cycle changes nothing");
});

test("every menu row id maps to its own config key", () => {
	const cases: Array<[string, string, Record<string, unknown>]> = [
		["mode", "plan", { mode: "plan" }],
		["readonly", "on", { readOnly: true }],
		["readonly", "off", { readOnly: false }],
		["permissions", "auto-approved", { skipPermissions: true }],
		["permissions", "prompt", { skipPermissions: false }],
		["model", "flash", { defaultModel: "flash" }],
		["thinking", "high", { defaultThinking: "high" }],
		["ask", "off", { askTool: false }],
		["web", "on", { webTools: true }],
		["bridge", "mcp", { bridgeTools: "mcp" }],
		["turn-cap", "12", { turnTimeoutMin: 12 }],
		["digest", "on", { digest: true }],
		["system-prompt", "off", { systemPrompt: false }],
		["not-a-row", "x", {}],
	];
	for (const [id, value, expected] of cases) {
		const pending: Record<string, unknown> = {};
		applySettingChange(pending as never, id, value);
		assert.deepEqual(pending, expected, `row ${id}=${value}`);
	}
});

test("choice rows: validated before any overlay opens", () => {
	const options = [
		{ value: "acp", label: "ACP" },
		{ value: "stream-json", label: "CLI" },
	];
	assert.deepEqual(buildChoiceItems(options).map((i) => i.value), ["acp", "stream-json"]);
	assert.throws(() => buildChoiceItems([]), /at least one option/);
	assert.throws(() => buildChoiceItems([...options, { value: "acp", label: "dup" }]), /duplicate choice value/);
});

test("choice menu: frame carries title, intro and options; cancel resolves undefined", async () => {
	const fake = fakeUi<string | undefined>(undefined);
	const pending = showChoiceMenu(fake.ui, {
		title: "Antigravity Bridge: choose your engine",
		intro: "Pick the engine that runs your turns.",
		options: [
			{ value: "acp", label: "ACP server (official Google)", description: "default" },
			{ value: "stream-json", label: "Stream-JSON CLI", description: "fallback" },
		],
	});
	const text = fake.render(90);
	assert.match(text, /choose your engine/);
	assert.match(text, /Pick the engine that runs your turns\./);
	assert.match(text, /ACP server/);
	assert.match(text, /Stream-JSON CLI/);
	fake.finish();
	assert.equal(await pending, undefined, "esc decides later: nothing is persisted");
});
