// Antigravity's engines buffer user input until the turn ends by default, while
// Pi sends interactive input mid-turn. Both engines read `queuedMessages` from
// their own settings.json, so the bridge sets it once per engine.
//
// The files are user-owned: the CLI one carries permissions, trusted
// workspaces, theme and model. So every write here is additive, atomic and
// fail-closed - an unreadable file is never touched, and an explicit user value
// (including "queue") always wins.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY = "queuedMessages";
const VALUE = "send-immediately";

export type EngineSettingsOutcome = "written" | "already-set" | "unreadable" | "unwritable";

/** The two engine settings files, CLI first. */
export function engineSettingsPaths(home: string = os.homedir()): string[] {
	return [
		path.join(home, ".gemini", "antigravity-cli", "settings.json"),
		path.join(home, ".gemini", "antigravity-acp", "settings.json"),
	];
}

/**
 * Set `queuedMessages: send-immediately` when the key is absent.
 *
 * Returns what happened instead of throwing: this runs at load and must never
 * fail a session over a settings file the user may not even use.
 */
export function ensureSendImmediately(settingsPath: string): EngineSettingsOutcome {
	let raw: string;
	try {
		raw = fs.readFileSync(settingsPath, "utf8");
	} catch (err) {
		// Only a missing file is ours to create; a permission error is not.
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return "unreadable";
		try {
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			writeAtomic(settingsPath, { [KEY]: VALUE });
			return "written";
		} catch {
			return "unwritable";
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "unreadable";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unreadable";

	const settings = parsed as Record<string, unknown>;
	if (KEY in settings) return "already-set";

	settings[KEY] = VALUE;
	try {
		writeAtomic(settingsPath, settings);
		return "written";
	} catch {
		return "unwritable";
	}
}

/** Write-then-rename so a crash can never leave a half-written settings file. */
function writeAtomic(target: string, value: unknown): void {
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, target);
}
