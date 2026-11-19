// Conflicting Antigravity bridge/auth detection for `/agy doctor`.
//
// Two Antigravity bridges installed side by side fight over the same provider
// ids and the same Google account: turns land on whichever extension loads
// last, auth refreshes race, and the user sees random failures instead of a
// diagnosis. This module reads Pi / Gentle Shell settings (the `packages`
// array is the authoritative install record) and reports every other
// Antigravity bridge or auth package, so doctor can name the conflict.
//
// Best effort by design, mirroring src/approval-detect.ts: a missing or
// corrupt settings file is normal and must stay silent. This package is never
// flagged, in any specifier shape (`npm:@3d24rd0/pi-antigravity-bridge@x`,
// bare `pi-antigravity-bridge`, or a local checkout of this repo).
//
// Run: npm test

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** npm names of the audited Antigravity bridges/auth packages that conflict
 *  with this one. */
export const KNOWN_CONFLICTING_BRIDGES = [
	"pi-antigravity",
	"@cortexkit/pi-antigravity-auth",
	"@estebanforge/pi-antigravity-bridge",
	"pi-antigravity-auth",
] as const;

/** This package: never a conflict, whatever the specifier looks like. */
const OWN_SCOPED_NAME = "@3d24rd0/pi-antigravity-bridge";
const OWN_NAMES: readonly string[] = [OWN_SCOPED_NAME, "pi-antigravity-bridge"];
/** Local checkout directory names that hold this package. */
const OWN_PATH_SUFFIXES: readonly string[] = ["pi-antigravity-bridge", "pi-extensions"];

/** Any non-`@3d24rd0` scoped Antigravity bridge/auth fork, exactly matched so
 *  longer lookalikes ("/pi-antigravity-bridge-extras") stay quiet. */
const SCOPED_CONFLICT_RE = /^@(?!3d24rd0\/)[a-z0-9._-]+\/pi-antigravity(?:-(?:bridge|auth))?$/i;

export interface BridgeConflictHit {
	/** The conflicting package name, without version or scheme. */
	name: string;
	/** The `packages` entry exactly as configured, for the warning text. */
	source: string;
	/** Settings file that declares it. */
	file: string;
}

function readJsonIfPresent(file: string): { packages?: unknown } | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Package specifiers from one settings file. Entries are either a string
 *  ("npm:name@1.2.3", "git:...", a path) or an object carrying `source`. */
function packagesFrom(settingsFile: string): string[] {
	const parsed = readJsonIfPresent(settingsFile);
	const raw = parsed?.packages;
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			const trimmed = entry.trim();
			if (trimmed) out.push(trimmed);
			continue;
		}
		if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			const source = (entry as Record<string, unknown>).source;
			if (typeof source === "string" && source.trim()) out.push(source.trim());
		}
	}
	return out;
}

/** Last path segment of a URL or filesystem path: "…/pi-antigravity.git#main"
 *  -> "pi-antigravity". */
function lastSegment(specifier: string): string {
	const cut = specifier.split("#")[0] ?? specifier;
	const trimmed = cut.replace(/\/+$/, "");
	const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
	return last.replace(/\.git$/i, "");
}

/** Drop a trailing version/range from an npm specifier, keeping the scope:
 *  "npm:@scope/name@1.2.3" -> "@scope/name", "pi-antigravity@1" -> "pi-antigravity". */
function stripVersion(specifier: string): string {
	const at = specifier.indexOf("@", specifier.startsWith("@") ? 1 : 0);
	return at > 0 ? specifier.slice(0, at) : specifier;
}

/** The package name a `packages` entry refers to, without scheme or version. */
function packageNameOf(entry: string): string | undefined {
	const lower = entry.toLowerCase();
	let name: string;
	if (lower.startsWith("npm:")) name = stripVersion(entry.slice(4));
	else if (lower.startsWith("git:")) name = lastSegment(entry.slice(4));
	else if (lower.startsWith("file:")) name = lastSegment(entry.slice(5));
	else if (lower.startsWith("link:")) name = lastSegment(entry.slice(5));
	else if (/^(?:~|\.|\/|[a-z]:[\\/])/i.test(entry)) name = lastSegment(entry);
	else name = stripVersion(entry);
	name = name.trim().replace(/\/+$/, "");
	return name === "" ? undefined : name.toLowerCase();
}

function isOwnPackage(name: string): boolean {
	if (OWN_NAMES.includes(name)) return true;
	return OWN_PATH_SUFFIXES.some((suffix) => name === suffix);
}

/** The conflicting package name an entry names, if any. */
function conflictingName(entry: string): string | undefined {
	const name = packageNameOf(entry);
	if (name === undefined || isOwnPackage(name)) return undefined;
	if ((KNOWN_CONFLICTING_BRIDGES as readonly string[]).includes(name)) return name;
	if (SCOPED_CONFLICT_RE.test(name)) return name;
	return undefined;
}

/** Resolve to one identity per file: the same settings file reached through a
 *  symlinked or relative path is scanned once. */
function identityOf(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

/** Default settings locations, plus `<agentDir>/settings.json` when the Pi
 *  agent dir is known. A `home` override (tests) deliberately suppresses the
 *  `PI_CODING_AGENT_DIR` fallback so a test never reads this machine's config. */
function candidateFiles(opts: { home?: string; cwd?: string; agentDir?: string; settingsFiles?: string[] }): string[] {
	const home = opts.home ?? os.homedir();
	const cwd = opts.cwd ?? process.cwd();
	const agentDir = opts.agentDir ?? (opts.home === undefined ? process.env.PI_CODING_AGENT_DIR : undefined);
	const candidates = [
		...(opts.settingsFiles ?? []),
		path.join(home, ".pi", "agent", "settings.json"),
		path.join(home, ".gentle-shell", "agent", "settings.json"),
		path.join(home, ".gentle-shell", "settings.json"),
		...(agentDir ? [path.join(agentDir, "settings.json")] : []),
		path.join(cwd, ".pi", "settings.json"),
		path.join(cwd, ".gentle-shell", "settings.json"),
	];
	const seen = new Set<string>();
	const files: string[] = [];
	for (const file of candidates) {
		if (!file) continue;
		const id = identityOf(file);
		if (seen.has(id)) continue;
		seen.add(id);
		files.push(file);
	}
	return files;
}

/**
 * Detect Antigravity bridges/auth packages configured alongside this one.
 *
 * @param opts.home  HOME override for tests.
 * @param opts.cwd   project dir override (project settings).
 * @param opts.agentDir  Pi agent dir override; empty string disables it.
 * @param opts.settingsFiles  extra settings files to scan.
 */
export function detectConflictingAntigravityBridges(
	opts: { home?: string; cwd?: string; agentDir?: string; settingsFiles?: string[] } = {},
): BridgeConflictHit[] {
	const hits: BridgeConflictHit[] = [];
	const seen = new Set<string>();
	for (const file of candidateFiles(opts)) {
		for (const entry of packagesFrom(file)) {
			const name = conflictingName(entry);
			if (name === undefined) continue;
			const key = `${name}\0${file}`;
			if (seen.has(key)) continue;
			seen.add(key);
			hits.push({ name, source: entry, file });
		}
	}
	return hits;
}

/** One-line summary for doctor's `conflicts:` row: package plus the settings
 *  file that declares it. */
export function summarizeBridgeConflicts(hits: readonly BridgeConflictHit[]): string {
	const byName = new Map<string, string[]>();
	for (const hit of hits) {
		const files = byName.get(hit.name);
		if (files === undefined) byName.set(hit.name, [hit.file]);
		else if (!files.includes(hit.file)) files.push(hit.file);
	}
	return [...byName.entries()].map(([name, files]) => `${name} (${files.join(", ")})`).join("; ");
}

/** Multi-line warning block for doctor, or undefined when there is nothing to
 *  report. Names every conflicting package with its settings file and the
 *  one package to keep. */
export function formatBridgeConflictWarning(hits: readonly BridgeConflictHit[]): string | undefined {
	if (hits.length === 0) return undefined;
	const lines = ["Conflicting Antigravity bridge packages configured:"];
	for (const hit of hits) lines.push(`  ${hit.name} (${hit.file})`);
	lines.push(
		"",
		`Keep only ${OWN_SCOPED_NAME}: two Antigravity bridges share the same provider ids and Google account, so turns and auth race. Remove the other entries from the packages array (in the files above), then restart Pi.`,
	);
	return lines.join("\n");
}
