// Settings menu built on pi's own TUI kit.
//
// The /agy settings surface used to come from @estebanforge/pi-tui-dialogs.
// Everything it needs is public in @earendil-works/pi-tui — the same
// SettingsList pi renders for /settings — so the bridge owns the thin frame
// (title, subtitle, rule lines, footer hint) instead of a third-party
// dependency shipped as unbundled TypeScript.
//
// Rows are pure data: id, label, description, currentValue and the closed set
// of values Enter/Space cycles through. Validation runs BEFORE the overlay
// opens, so a broken row list is a programming error, never a half-rendered
// dialog.

import { SelectList, SettingsList, wrapTextWithAnsi, type Component, type SelectItem, type SettingItem, type SelectListTheme, type SettingsListTheme, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

/** One settings row. `values` is never empty: every row cycles in place. */
export interface MenuRow {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values: readonly string[];
}

export interface SettingsMenuOptions {
	title: string;
	/** Muted line under the title (for example the config file path). */
	subtitle?: string;
	rows: readonly MenuRow[];
	/** Footer hint; defaults to {@link MENU_FOOTER}. */
	footer?: string;
	/** Called after an in-place cycle commits a new value. */
	onChange: (id: string, value: string) => void;
}

export const MENU_FOOTER = "↑↓ navigate · Enter/Space cycle · Type to search · Esc close";

/** Centered overlay, matching the geometry the previous dialog kit used. */
export const MENU_OVERLAY = {
	overlay: true,
	overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
} as const;

/** Theme mapping copied from pi's own settings selector so the surface reads
 *  like /settings: accent for the selected row, muted values, dim hints. */
export function settingsMenuTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

/** Rows -> SettingsList items. Throws on a duplicate id, an empty value set,
 *  or a current value outside its own value set: each of those would render
 *  a row whose cycle lands somewhere the caller cannot map back. */
export function buildMenuItems(rows: readonly MenuRow[]): SettingItem[] {
	const seen = new Set<string>();
	return rows.map((row) => {
		if (seen.has(row.id)) throw new Error(`duplicate settings row id "${row.id}"`);
		seen.add(row.id);
		if (row.values.length === 0) throw new Error(`settings row "${row.id}" needs at least one value`);
		if (!row.values.includes(row.currentValue)) {
			throw new Error(
				`settings row "${row.id}" current value "${row.currentValue}" is not one of ${JSON.stringify(row.values)}`,
			);
		}
		return {
			id: row.id,
			label: row.label,
			...(row.description === undefined ? {} : { description: row.description }),
			currentValue: row.currentValue,
			values: [...row.values],
		};
	});
}

/** Frame around the list: a rule, the title, the subtitle, the list and the
 *  footer hint. Rendered per call so the rule follows the overlay width. */
class FramedMenu implements Component {
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly title: string,
		private readonly subtitle: string | undefined,
		private readonly list: SettingsList,
		private readonly footer: string,
	) {}

	render(width: number): string[] {
		const rule = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const lines = [rule, this.theme.fg("accent", ` ${this.title}`)];
		if (this.subtitle) lines.push(this.theme.fg("dim", ` ${this.subtitle}`));
		lines.push(...this.list.render(width));
		lines.push(this.theme.fg("dim", ` ${this.footer}`), rule);
		return lines;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

/** Show the menu and resolve when it closes (Esc or a committed change). The
 *  caller reads the accumulated changes from its own onChange bookkeeping. */
export async function showSettingsMenu(ui: ExtensionUIContext, opts: SettingsMenuOptions): Promise<void> {
	const items = buildMenuItems(opts.rows);
	await ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const list = new SettingsList(
				items,
				Math.min(items.length, 12),
				settingsMenuTheme(theme),
				(id, value) => opts.onChange(id, value),
				() => done(undefined),
				{ enableSearch: true },
			);
			return new FramedMenu(tui, theme, opts.title, opts.subtitle, list, opts.footer ?? MENU_FOOTER);
		},
		MENU_OVERLAY,
	);
}

/** One option of a closed choice. Values are persisted by callers, so they
 *  must stay stable. */
export interface ChoiceRow {
	value: string;
	label: string;
	description?: string;
}

export interface ChoiceMenuOptions {
	title: string;
	/** Paragraph(s) above the list; wrapped to the overlay width. */
	intro?: string;
	options: readonly ChoiceRow[];
	footer?: string;
}

export const CHOICE_FOOTER = "↑↓ navigate · Enter select · Esc cancel";

/** Accent/muted selector theme, mirroring pi's own pickers. */
export function choiceMenuTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("dim", text),
	};
}

/** Choice rows -> SelectList items. Throws on an empty list or duplicate
 *  values before any overlay opens: a choice whose values collide cannot be
 *  mapped back to a persisted answer. */
export function buildChoiceItems(options: readonly ChoiceRow[]): SelectItem[] {
	if (options.length === 0) throw new Error("choice menu needs at least one option");
	const seen = new Set<string>();
	return options.map((option) => {
		if (seen.has(option.value)) throw new Error(`duplicate choice value "${option.value}"`);
		seen.add(option.value);
		return { value: option.value, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) };
	});
}

/** Frame around the selector: rule, title, wrapped intro, list, hint. */
class FramedChoice implements Component {
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly title: string,
		private readonly intro: string | undefined,
		private readonly list: SelectList,
		private readonly footer: string,
	) {}

	render(width: number): string[] {
		const rule = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const lines = [rule, this.theme.fg("accent", ` ${this.title}`)];
		for (const paragraph of (this.intro ?? "").split("\n")) {
			if (!paragraph.trim()) {
				lines.push("");
				continue;
			}
			for (const wrapped of wrapTextWithAnsi(paragraph, Math.max(10, width - 2))) lines.push(` ${wrapped}`);
		}
		lines.push(...this.list.render(width), this.theme.fg("dim", ` ${this.footer}`), rule);
		return lines;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

/** Show a closed choice and resolve with the picked value, or undefined when
 *  the user cancelled. */
export async function showChoiceMenu(ui: ExtensionUIContext, opts: ChoiceMenuOptions): Promise<string | undefined> {
	const items = buildChoiceItems(opts.options);
	return ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => {
			const list = new SelectList(items, Math.min(items.length, 10), choiceMenuTheme(theme));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			return new FramedChoice(tui, theme, opts.title, opts.intro, list, opts.footer ?? CHOICE_FOOTER);
		},
		MENU_OVERLAY,
	);
}
