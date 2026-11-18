// Keeping the ACP server build current.
//
// The install layout already supports this: every build lands in
// `<root>/<build>/` and `<root>/current` points at the live one, so an update
// adds a directory and moves a symlink. What was missing is (a) asking the
// registry what the current build is, (b) noticing that the configured binary
// is older, and (c) never switching to a build that does not start.
//
// Auto-setup pins the RESOLVED path (…/1.4.1/agy_acp_server.par) in
// config.acp.bin, which is why an installed 1.4.1 stays forever even after the
// registry moves on. A pin inside `<root>` is ours and the updater may move it;
// a pin outside is the user's and is reported, never overwritten.
//
// Nothing here downloads unless an update was found AND the caller asked for
// one: the check is one small JSON fetch, cached for hours.

import fs from "node:fs";
import path from "node:path";
import { bridgeDataDir } from "../config.js";
import { AcpConnection } from "./connection.js";
import {
	buildIdFromArchive,
	defaultInstallRoot,
	fetchRegistryBinary,
	installAcpBinary,
	platformKey,
	pointCurrent,
	type InstallResult,
	type SetupOptions,
} from "./setup.js";

/** How long a registry answer is trusted. Six hours keeps a startup notice
 *  cheap: at most a couple of tiny fetches a day, never one per session. */
export const REGISTRY_CACHE_TTL_MS = 6 * 60 * 60_000;

/** Build id from the configured binary path:
 *  `<root>/1.4.1/agy_acp_server.par` -> "1.4.1"; a path through the `current`
 *  link resolves to the build it points at; anything else -> null. */
export function buildIdFromBinaryPath(bin: string | null | undefined): string | null {
	if (!bin) return null;
	let resolved = bin;
	try {
		resolved = fs.realpathSync(bin);
	} catch {
		/* not on disk yet (or a fixture): reason about the given path */
	}
	const dir = path.dirname(resolved);
	const name = path.basename(dir);
	if (/^\d+(\.\d+)*$/.test(name)) return name;
	if (name === "current") {
		try {
			return path.basename(fs.readlinkSync(dir));
		} catch {
			return null;
		}
	}
	return null;
}

/** True when `bin` lives inside the managed install root: the updater owns it. */
export function isManagedBinary(bin: string | null | undefined, root = defaultInstallRoot()): boolean {
	if (!bin) return false;
	const rel = path.relative(root, path.resolve(bin));
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface RegistryBuild {
	build: string;
	archive: string;
	savedAt: number;
}

interface CacheShape {
	savedAt: number;
	build: string;
	archive: string;
	platform: string;
}

export interface RegistryQuery {
	/** Registry platform key (default: this machine's). */
	platform?: string;
	/** Ignore the cache (the explicit command). */
	force?: boolean;
	cachePath?: string;
	registryUrl?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

function defaultCachePath(): string {
	return path.join(bridgeDataDir(), "acp-registry.json");
}

/** What the registry currently publishes for this platform. Throws when the
 *  registry is unreachable: callers decide whether that is noise or an error. */
export async function latestRegistryBuild(opts: RegistryQuery = {}): Promise<RegistryBuild> {
	const cachePath = opts.cachePath ?? defaultCachePath();
	const platform = opts.platform ?? platformKey();
	const now = opts.now ?? Date.now;
	if (!opts.force) {
		try {
			const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CacheShape;
			if (cached.platform === platform && now() - cached.savedAt < REGISTRY_CACHE_TTL_MS) {
				return { build: cached.build, archive: cached.archive, savedAt: cached.savedAt };
			}
		} catch {
			/* missing or corrupt: fetch */
		}
	}
	const entry = await fetchRegistryBinary({ registryUrl: opts.registryUrl, fetchImpl: opts.fetchImpl }, platform);
	const build = buildIdFromArchive(entry.archive);
	const record: CacheShape = { savedAt: now(), build, archive: entry.archive, platform };
	try {
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
	} catch {
		/* a read-only data dir must not fail a check */
	}
	return { build, archive: entry.archive, savedAt: record.savedAt };
}

export interface AcpUpdateCheck {
	/** Build in use, from the configured path or the `current` link. */
	current: string | null;
	/** Build the registry publishes now. */
	latest: string;
	updateAvailable: boolean;
}

/** Compare the build in use with the registry's. One small fetch at most. */
export async function checkAcpUpdate(
	currentBin: string | null | undefined,
	opts: RegistryQuery = {},
): Promise<AcpUpdateCheck> {
	const registry = await latestRegistryBuild(opts);
	const current = buildIdFromBinaryPath(currentBin) ?? currentBuildFromRoot(opts);
	return {
		current,
		latest: registry.build,
		updateAvailable: current !== null && current !== registry.build,
	};
}

/** Build the `current` link points at, when the config carries no usable pin. */
function currentBuildFromRoot(opts: RegistryQuery): string | null {
	const root = defaultInstallRoot();
	try {
		return path.basename(fs.readlinkSync(path.join(root, "current")));
	} catch {
		return null;
	}
}

/** Default validator: the build must answer `initialize`. No auth involved, so
 *  this is safe to run before switching and it catches a broken download, a
 *  wrong architecture, and the Debian `nobody` group abort. */
export async function probeServerBinary(bin: string, cwd = process.cwd()): Promise<boolean> {
	const conn = new AcpConnection({
		bin,
		cwd,
		log: () => {},
		onUpdate: () => {},
		onExit: () => {},
	});
	try {
		await conn.start();
		return true;
	} catch {
		return false;
	} finally {
		conn.kill();
	}
}

export interface AcpUpdateOptions extends SetupOptions {
	/** Build currently configured (config.acp.bin). */
	currentBin?: string | null;
	/** Registry cache file (tests point this at a fixture). */
	cachePath?: string;
	/** Validate the freshly installed build before making it current. */
	validate?: (bin: string) => Promise<boolean>;
	/** Ignore the registry cache. */
	force?: boolean;
}

export interface AcpUpdateResult {
	ok: boolean;
	/** Nothing to do: the configured build is the registry's. */
	upToDate?: boolean;
	from: string | null;
	to: string | null;
	/** Binary path of the new build, when it became current. */
	bin?: string;
	/** The new build did not answer initialize; the old one is untouched. */
	validationFailed?: boolean;
	error?: string;
}

/** Install the registry's build, validate it, and only then make it current.
 *  Never deletes the previous build, so reverting is pointing the config back
 *  at it. */
export async function updateAcp(opts: AcpUpdateOptions = {}): Promise<AcpUpdateResult> {
	const root = opts.installRoot ?? defaultInstallRoot();
	let registry: RegistryBuild;
	try {
		registry = await latestRegistryBuild({
			force: opts.force,
			registryUrl: opts.registryUrl,
			fetchImpl: opts.fetchImpl,
			platform: opts.platform,
			cachePath: opts.cachePath,
		});
	} catch (err) {
		return { ok: false, from: buildIdFromBinaryPath(opts.currentBin), to: null, error: `registry: ${String(err)}` };
	}
	const current = buildIdFromBinaryPath(opts.currentBin) ?? currentBuildFromRoot({});
	if (current === registry.build) {
		return { ok: true, upToDate: true, from: current, to: registry.build };
	}

	let installed: InstallResult;
	try {
		opts.onProgress?.(`downloading ACP server (build ${registry.build})…`);
		installed = await installAcpBinary({ ...opts, installRoot: root, switchCurrent: false });
	} catch (err) {
		return { ok: false, from: current, to: registry.build, error: `install: ${String(err)}` };
	}

	const validate = opts.validate ?? probeServerBinary;
	if (!(await validate(installed.bin))) {
		return {
			ok: false,
			from: current,
			to: registry.build,
			validationFailed: true,
			error: `build ${registry.build} did not answer initialize; ${current ?? "the previous build"} is still current`,
		};
	}

	pointCurrent(root, installed.build);
	opts.onProgress?.("ACP server installed.");
	return { ok: true, from: current, to: installed.build, bin: installed.bin };
}

/** Data dir note for callers that surface the cache path (doctor/tests). */
export function registryCachePath(): string {
	return defaultCachePath();
}

/** Default install root, re-exported so callers do not import setup twice. */
export { defaultInstallRoot };
