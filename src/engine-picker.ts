// First-run onboarding: the engine picker plus the agy-presence warning.
//
// On the first interactive start (no config file yet, no AGY_ENGINE env) pi
// asks which turn engine to use: the stream-json `agy` CLI or Google's
// official ACP server. The choice persists via saveConfig({ engine }) and,
// like /agy engine, takes effect on the next pi start (drivers wire at load).
// Every start with the stream-json engine active also re-checks that the
// `agy` binary exists and warns until it does (re-auth is out of scope).
//
// UI: the framed choice overlay built on pi-tui's SelectList (src/settings-menu.ts):
// one decision statement, a closed option list, esc cancels.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { showChoiceMenu, type ChoiceRow } from "./settings-menu.js";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ENGINE, type Engine } from "./config.js";

/** Picker order is the default answer order: acp (the default engine)
 *  preselected first, stream-json as the fallback. */
export const ENGINE_PICKER_ITEMS: ChoiceRow[] = [
	{
		value: "acp",
		label: "ACP server (official Google)",
		description: "default · official Google server",
	},
	{
		value: "stream-json",
		label: "Stream-JSON CLI",
		description: "the `agy` CLI, fallback",
	},
];

/** Intro paragraph above the list. Text wraps, so explanations stay here and
 *  option descriptions stay one-liners (the choice list truncates long lines). */
export const ENGINE_PICKER_INTRO = [
	"Pick the engine that runs your Antigravity turns. Switch anytime with /agy engine (restart applies it).",
	"",
	"ACP (default): Google's official server (agy_acp_server.par). Needs a second Google sign-in and a ~1.5 GB server binary downloaded from Google (automatic, one-time, unavoidable: the server is not part of the agy CLI).",
	"stream-json (fallback): the `agy` CLI you already installed and authenticated. Persistent process, streamed output.",
].join("\n");

/** True only for a genuine first interactive run: no saved config yet (any
 *  existing file means the user has been here before) and no AGY_ENGINE env
 *  (env wins over the file, so the wizard would fight it). Fails closed to
 *  false - an fs error must never nag the user with a dialog. */
export function shouldOfferEnginePicker(
	configPath: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.AGY_ENGINE !== undefined) return false;
	try {
		return !fs.existsSync(configPath);
	} catch {
		return false;
	}
}

/** Narrow a picker value to an Engine. Items are our own constants, but an
 *  unknown value must never reach config as a cast string: it falls back to
 *  the default engine (acp), same rule as loadConfig's narrowing. */
export function toEngine(value: string): Engine {
	return value === "acp" || value === "stream-json" ? value : DEFAULT_ENGINE;
}

/** Toast copy shown after the choice is saved. ACP names the promise that
 *  matters: the binary download starts NOW (not on restart), sign-in follows
 *  when it lands, restart applies the engine. */
export function savedEngineMessage(engine: Engine): string {
	return engine === "acp"
		? "Engine saved: acp. The ~1.5 GB server binary downloads now; the Google sign-in opens when it lands. Restart applies the engine."
		: "Engine saved: stream-json. Restart pi to apply.";
}

/** True when the `agy` CLI binary can be found. A binRef with a path
 *  separator (`/` or, on Windows, `\`) must exist as a file; a bare name is
 *  searched on PATH, trying `PATHEXT` extensions on Windows (`agy.exe`,
 *  `agy.cmd`) so a working install is never reported missing. statSync cannot
 *  throw through the guards, but a race (file removed between listing and
 *  stat) fails closed to false. */
export function isAgyInstalled(
	binRef: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (path.isAbsolute(binRef) || binRef.includes("/") || binRef.includes("\\")) {
		try {
			return fs.statSync(binRef).isFile();
		} catch {
			return false;
		}
	}
	const extensions =
		platform === "win32"
			? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
			: [""];
	// Only a PATHEXT suffix counts as an explicit extension. A dotted bare name
	// (agy.v2) is still resolved through PATHEXT, so a working install is not
	// reported missing (JD-B-005).
	const explicitExtension =
		platform !== "win32" || extensions.some((ext) => binRef.toLowerCase().endsWith(ext.toLowerCase()));
	const candidates = explicitExtension ? [""] : extensions;
	return (env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.some((dir) => {
			for (const ext of candidates) {
				try {
					if (fs.statSync(path.join(dir, binRef + ext)).isFile()) return true;
				} catch {
					/* keep looking */
				}
			}
			return false;
		});
}

/** Toast copy for the missing-CLI warning. Fires every pi start while the
 *  stream-json engine is active and the binary is absent. */
export function agyMissingMessage(): string {
	return "The `agy` CLI is not installed. Install it from https://antigravity.google/product/antigravity-cli and log in on it to use Antigravity models.";
}

/** Render the engine choice. Resolves with the chosen engine, or undefined
 *  when the user cancelled (decide later - nothing is persisted). */
export async function showEnginePicker(ctx: ExtensionUIContext): Promise<Engine | undefined> {
	const picked = await showChoiceMenu(ctx, {
		title: "Antigravity Bridge: choose your engine",
		intro: ENGINE_PICKER_INTRO,
		options: ENGINE_PICKER_ITEMS,
		footer: "↑↓ navigate · enter select · esc decide later",
	});
	return picked === undefined ? undefined : toEngine(picked);
}
