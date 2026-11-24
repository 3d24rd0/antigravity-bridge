// ACP setup module tests. Fully offline: the registry and the archive come
// from an injected fetch, unpacking from an injected copier, and every path
// (install root, settings dir, env) points at a temp dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
	buildIdFromArchive,
	describeAuthDiagnosis,
	diagnoseAuth,
	ensureAcpReady,
	installAcpBinary,
	inspectAcpSetup,
	inspectAuthDrift,
	launchConfigFor,
	MANUAL_SETUP,
	platformKey,
	readAuthState,
	writeAcpAuthVerified,
	writeAuthType,
} from "../src/acp/setup.js";

const BUILD = "agy_acp_server_20991231_01_TEST";
const ARCHIVE = `https://dl.google.com/agy-extensions/releases/x/agy-acp-server-${BUILD}-${platformKey().replace("aarch64", "arm64")}.zip`;

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-setup-"));
}

function fakeFetch(registryBody: unknown, archiveBody = "fake-zip-bytes"): typeof fetch {
	return (async (url: Parameters<typeof fetch>[0]) => {
		if (String(url).endsWith(".zip")) {
			return new Response(archiveBody, { status: 200 });
		}
		return new Response(JSON.stringify(registryBody), { status: 200 });
	}) as typeof fetch;
}

function fakeUnpack(archive: string, dest: string): Promise<void> {
	const bin = path.join(dest, "agy_acp_server.par");
	fs.writeFileSync(bin, "#!/bin/sh\n");
	fs.chmodSync(bin, 0o755);
	void archive;
	return Promise.resolve();
}

const REGISTRY = {
	id: "antigravity-acp",
	distribution: {
		binary: {
			[platformKey()]: { archive: ARCHIVE, cmd: "./agy_acp_server.par" },
		},
	},
};

describe("acp/setup registry parsing", () => {
	test("buildIdFromArchive parses the real registry URL shape", () => {
		const url =
			"https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_20260818_01_RC01-darwin-arm64.zip";
		assert.equal(buildIdFromArchive(url), "agy_acp_server_20260818_01_RC01");
	});

	test("buildIdFromArchive rejects unrecognized names", () => {
		assert.throws(() => buildIdFromArchive("https://x/thing.zip"));
	});

	test("platformKey maps platform+arch", () => {
		assert.match(platformKey(), /^(darwin|linux|windows)-(aarch64|x86_64)$/);
	});
});

describe("acp/setup auth state", () => {
	test("absent settings and token = unconfigured", () => {
		assert.deepEqual(readAuthState(tmpDir()), { configured: false });
	});

	test("settings.json type is detected", () => {
		const dir = tmpDir();
		writeAuthType("gemini-api-key", dir);
		assert.deepEqual(readAuthState(dir), { configured: true, type: "gemini-api-key" });
		// Fresh file is created user-only (matches acp_token.json 0600).
		const mode = fs.statSync(path.join(dir, "settings.json")).mode & 0o777;
		assert.equal(mode, 0o600);
	});

	test("acp_token.json presence means configured without reading it", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "acp_token.json"), "credential-not-read");
		assert.deepEqual(readAuthState(dir), { configured: true, type: "token" });
	});

	test("writeAuthType preserves unrelated settings and auth keys", () => {
		const dir = tmpDir();
		const file = path.join(dir, "settings.json");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({ auth: { type: "oauth-personal", keepme: 1 }, gcp: { project: "p" } }),
		);
		writeAuthType("gemini-api-key", dir);
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
			auth: Record<string, unknown>;
			gcp?: unknown;
		};
		assert.equal(parsed.auth.type, "gemini-api-key");
		assert.equal(parsed.auth.keepme, 1);
		assert.deepEqual(parsed.gcp, { project: "p" });
	});
});

describe("acp/setup auth diagnosis", () => {
	// A declared credential method whose credential is absent cannot
	// authenticate: the server fails session/new. The bridge must know that
	// before spawning, so setup/doctor/the update notice share one verdict.
	const oauth = (token: boolean) => ({ token, apiKey: false });

	test("a declared API key with the key set is healthy", () => {
		const d = diagnoseAuth({ configured: true, type: "gemini-api-key" }, { token: false, apiKey: true });
		assert.equal(d.broken, false);
		assert.equal(d.repairable, false);
		assert.equal(describeAuthDiagnosis(d), "gemini-api-key (GEMINI_API_KEY set)");
	});

	test("a declared API key with a login present is broken but repairable", () => {
		const d = diagnoseAuth({ configured: true, type: "gemini-api-key" }, oauth(true));
		assert.equal(d.broken, true);
		assert.equal(d.repairable, true);
		assert.equal(
			describeAuthDiagnosis(d),
			"gemini-api-key without GEMINI_API_KEY; a Google login is present, so setup restores oauth-personal",
		);
	});

	test("a declared API key with no credential at all names both routes", () => {
		const d = diagnoseAuth({ configured: true, type: "gemini-api-key" }, oauth(false));
		assert.equal(d.broken, true);
		assert.equal(d.repairable, false);
		assert.equal(
			describeAuthDiagnosis(d),
			'gemini-api-key without GEMINI_API_KEY and no Google login: set GEMINI_API_KEY, or put {"auth":{"type":"oauth-personal"}} in settings.json and run /agy auth',
		);
	});

	test("oauth-personal is healthy once the login landed", () => {
		const d = diagnoseAuth({ configured: true, type: "oauth-personal" }, oauth(true));
		assert.equal(d.broken, false);
		assert.equal(describeAuthDiagnosis(d), "oauth-personal (signed in)");
	});

	test("oauth-personal without a login is healthy but says so", () => {
		const d = diagnoseAuth({ configured: true, type: "oauth-personal" }, oauth(false));
		assert.equal(d.broken, false);
		assert.equal(describeAuthDiagnosis(d), "oauth-personal (no sign-in yet; /agy auth)");
	});

	test("an unconfigured dir is never broken", () => {
		const d = diagnoseAuth({ configured: false }, oauth(false));
		assert.equal(d.declared, undefined);
		assert.equal(d.broken, false);
		assert.equal(describeAuthDiagnosis(d), "not configured");
	});

	test("a login-only state reads as signed in", () => {
		// settings.json without an auth block but acp_token.json present: the
		// server is usable, so doctor must not report a missing method.
		const d = diagnoseAuth({ configured: true, type: "token" }, oauth(true));
		assert.equal(d.broken, false);
		assert.equal(describeAuthDiagnosis(d), "token (signed in)");
	});
});

describe("acp/setup ensureAcpReady", () => {
	test("ready installation is a no-op with no network", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		writeAuthType("oauth-personal", gdir);
		fs.writeFileSync(path.join(gdir, "acp_token.json"), "credential-not-read");

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: {},
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.bin, bin);
		assert.equal(status.binarySource, "existing");
		assert.equal(status.auth, "oauth-personal");
		assert.deepEqual(status.actions, []);
		assert.equal(status.needsLogin, false);
	});

	test("a server rewrite to gemini-api-key meets the intact login and is repaired", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		// State observed in the field: an agy update rewrote settings.json, the
		// Google login from before it is still on disk, no API key anywhere.
		writeAuthType("gemini-api-key", gdir);
		fs.writeFileSync(path.join(gdir, "acp_token.json"), "credential-not-read");
		const progress: string[] = [];

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: {},
			onProgress: (m) => progress.push(m),
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.auth, "oauth-personal");
		// The login is intact, so nothing asks the user to sign in again.
		assert.equal(status.needsLogin, false);
		assert.equal(status.actions.length, 1);
		assert.match(status.actions[0], /restored oauth-personal/);
		assert.equal(progress.length, 1);
		assert.match(progress[0], /API key .* not set/);
		// The repair is written, so the next spawn reads a workable method.
		assert.equal(readAuthState(gdir).type, "oauth-personal");
	});

	test("a server rewrite to gemini-api-key with no credential fails with both routes", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		writeAuthType("gemini-api-key", gdir);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: {},
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, false);
		if (status.ok) return;
		assert.equal(status.stage, "auth");
		assert.match(status.error, /GEMINI_API_KEY/);
		assert.match(status.error, /oauth-personal/);
		assert.match(status.error, /\/agy auth/);
		// Nothing to repair with: the server's file is left as the user has it.
		assert.equal(readAuthState(gdir).type, "gemini-api-key");
	});

	test("a declared API key with the key set is left alone", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		writeAuthType("gemini-api-key", gdir);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: { GEMINI_API_KEY: "k" },
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.auth, "gemini-api-key");
		assert.equal(status.needsLogin, false);
		assert.deepEqual(status.actions, []);
		assert.equal(readAuthState(gdir).type, "gemini-api-key");
	});

	test("installs from the registry when missing; oauth-personal is the default even with GEMINI_API_KEY set", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			// Hermetic: never let a developer-machine marker flip the assertion.
			authVerifiedFile: path.join(tmpDir(), "none.json"),
			env: { GEMINI_API_KEY: "k" },
			fetchImpl: fakeFetch(REGISTRY),
			unpack: fakeUnpack,
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.binarySource, "installed");
		// The subscription login is the default; an exported key must not flip it
		// (the key path is metered paid API, not the Antigravity plan).
		assert.equal(status.auth, "oauth-personal");
		assert.equal(status.needsLogin, true);
		assert.equal(status.bin, path.join(root, BUILD, "agy_acp_server.par"));
		// Managed layout: current symlink + recorded zip sha256.
		assert.equal(fs.readlinkSync(path.join(root, "current")), BUILD);
		const sha = fs.readFileSync(path.join(root, BUILD, "zip.sha256"), "utf8");
		assert.match(sha, /^[0-9a-f]{64}  /);
		// Auth was written before any server could spawn.
		assert.deepEqual(readAuthState(gdir), { configured: true, type: "oauth-personal" });
		assert.match(status.actions.join("\n"), /installed ACP server build/);
	});

	test("oauth-personal wins when GEMINI_API_KEY is also exported", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		writeAuthType("oauth-personal", gdir);
		const settingsFile = path.join(gdir, "settings.json");
		const before = fs.readFileSync(settingsFile, "utf8");
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			// Hermetic: never let a developer-machine marker flip the assertion.
			authVerifiedFile: path.join(tmpDir(), "none.json"),
			env: { GEMINI_API_KEY: "k" },
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		// Subscription login stays selected; the key is not written anywhere and
		// settings.json is untouched (the server uses auth.type, not env presence).
		assert.equal(status.auth, "oauth-personal");
		assert.deepEqual(status.actions, []);
		// settings.json alone is not a login: the token file only appears after
		// the browser round-trip, so setup must keep reporting login-pending
		// (the session_start self-heal repeats the notice until then).
		assert.equal(status.needsLogin, true);
		assert.equal(fs.readFileSync(settingsFile, "utf8"), before);
		assert.equal(fs.readdirSync(gdir).includes("acp_token.json"), false);
	});

	test("a completed login (token file present) is not login-pending", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		writeAuthType("oauth-personal", gdir);
		fs.writeFileSync(path.join(gdir, "acp_token.json"), "{}");
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: {},
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.auth, "oauth-personal");
		assert.deepEqual(status.actions, []);
		assert.equal(status.needsLogin, false);
	});

	test("a verified sign-in marker suppresses login-pending without a token file", async () => {
		// 1.1.1 servers can hold credentials the bridge cannot see (legacy
		// ~/.gemini artifacts): after a verified sign-in the nag must stop even
		// though acp_token.json never appears.
		const root = tmpDir();
		const gdir = tmpDir();
		writeAuthType("oauth-personal", gdir);
		const verifiedFile = path.join(tmpDir(), "verified.json");
		writeAcpAuthVerified(verifiedFile);
		fs.mkdirSync(path.join(root, "current"), { recursive: true });
		const bin = path.join(root, "current", "agy_acp_server.par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);

		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			authVerifiedFile: verifiedFile,
			env: {},
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.needsLogin, false);
	});

	test("install failure returns the manual fallback text", async () => {
		const status = await ensureAcpReady({
			installRoot: tmpDir(),
			geminiDir: tmpDir(),
			env: {},
			fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
		});
		assert.equal(status.ok, false);
		if (status.ok) return;
		assert.equal(status.stage, "install");
		assert.match(status.error, /HTTP 500/);
		assert.equal(status.manual, MANUAL_SETUP);
	});

	test("env binary wins and skips the registry", async () => {
		const root = tmpDir();
		const gdir = tmpDir();
		// Auth fixture is incidental here (binary resolution is the subject): keep
		// it healthy so this test does not depend on the auth diagnosis rules.
		writeAuthType("oauth-personal", gdir);
		fs.writeFileSync(path.join(gdir, "acp_token.json"), "credential-not-read");
		const bin = path.join(tmpDir(), "par");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		const status = await ensureAcpReady({
			installRoot: root,
			geminiDir: gdir,
			env: { AGY_ACP_BIN: bin },
			fetchImpl: () => Promise.reject(new Error("network must not be touched")),
		});
		assert.equal(status.ok, true);
		if (!status.ok) return;
		assert.equal(status.binarySource, "env");
		assert.equal(status.bin, bin);
	});
});

describe("acp/setup inspectAcpSetup", () => {
	test("empty dirs report nothing configured", () => {
		const state = inspectAcpSetup({ installRoot: tmpDir(), geminiDir: tmpDir(), env: {} });
		assert.equal(state.bin, null);
		assert.equal(state.source, null);
		assert.equal(state.auth, null);
	});

	test("a verified marker reads as healthy when no token file exists", () => {
		// Servers that authenticate from artifacts outside antigravity-acp never
		// write acp_token.json; doctor must show that state as verified, not bare.
		const gdir = tmpDir();
		writeAuthType("oauth-personal", gdir);
		const verifiedFile = path.join(tmpDir(), "verified.json");
		writeAcpAuthVerified(verifiedFile);
		const state = inspectAcpSetup({ installRoot: tmpDir(), geminiDir: gdir, authVerifiedFile: verifiedFile, env: {} });
		assert.equal(state.auth, "oauth-personal (verified, no token file)");
	});
});

// The registry declares how each platform's binary is meant to be RUN:
// FORMAT.md defines a `binary` distribution as "download, extract, run" with
// optional `args` and `env`, and Google declares `--uid=` for Linux (the flag
// that stops the server switching to a group Debian/Ubuntu does not have).
describe("acp/setup inspectAuthDrift", () => {
	test("reads the drifted state the server left behind", () => {
		const gdir = tmpDir();
		writeAuthType("gemini-api-key", gdir);
		fs.writeFileSync(path.join(gdir, "acp_token.json"), "credential-not-read");

		const d = inspectAuthDrift({ geminiDir: gdir, env: {} });
		assert.equal(d.declared, "gemini-api-key");
		assert.equal(d.broken, true);
		assert.equal(d.repairable, true);
		// The same disk state is healthy once the declared key exists.
		assert.equal(inspectAuthDrift({ geminiDir: gdir, env: { GEMINI_API_KEY: "k" } }).broken, false);
		// A blank or whitespace-only variable is not a usable key: the server would
		// read it as empty, so the diagnosis must too.
		assert.equal(inspectAuthDrift({ geminiDir: gdir, env: { GEMINI_API_KEY: "   " } }).broken, true);
	});
});

describe("acp/setup launch definition", () => {
	const withLaunch = (args: unknown, env?: unknown) => ({
		id: "antigravity-acp",
		distribution: {
			binary: {
				[platformKey()]: { archive: ARCHIVE, cmd: "./agy_acp_server.par", args, ...(env === undefined ? {} : { env }) },
			},
		},
	});

	test("install records the declared args and env for the build", async () => {
		const root = tmpDir();
		const res = await installAcpBinary({
			installRoot: root,
			fetchImpl: fakeFetch(withLaunch(["--uid=", "--profile"], { AGY_X: "1", IGNORED: 5 })),
			unpack: fakeUnpack,
		});
		const launch = JSON.parse(fs.readFileSync(path.join(root, BUILD, "launch.json"), "utf8")) as {
			build: string;
			args: string[];
			env: Record<string, string>;
		};
		assert.equal(launch.build, BUILD);
		assert.deepEqual(launch.args, ["--uid=", "--profile"]);
		assert.deepEqual(launch.env, { AGY_X: "1" }, "non-string env entries are dropped");
		assert.deepEqual(res.launch.args, ["--uid=", "--profile"]);
		assert.deepEqual(launchConfigFor(res.bin).args, ["--uid=", "--profile"]);
	});

	test("a registry entry with no args records none (macOS today)", async () => {
		const root = tmpDir();
		const res = await installAcpBinary({ installRoot: root, fetchImpl: fakeFetch(withLaunch(undefined)), unpack: fakeUnpack });
		assert.deepEqual(res.launch.args, []);
		assert.deepEqual(launchConfigFor(res.bin).env, {});
	});

	test("a legacy install with no record is retro-fitted only when the build matches", async () => {
		const root = tmpDir();
		// First install writes no record (simulating an old layout).
		await installAcpBinary({ installRoot: root, fetchImpl: fakeFetch(withLaunch(undefined)), unpack: fakeUnpack });
		fs.rmSync(path.join(root, BUILD, "launch.json"), { force: true });

		const again = await installAcpBinary({
			installRoot: root,
			fetchImpl: fakeFetch(withLaunch(["--uid="])),
			unpack: fakeUnpack,
		});
		assert.equal(again.downloaded, false, "already installed: no second download");
		assert.deepEqual(launchConfigFor(again.bin).args, ["--uid="], "the declared args are recorded");
	});

	test("a record on disk is never overwritten by a different declaration", async () => {
		const root = tmpDir();
		await installAcpBinary({ installRoot: root, fetchImpl: fakeFetch(withLaunch(["--uid="])), unpack: fakeUnpack });
		const again = await installAcpBinary({
			installRoot: root,
			fetchImpl: fakeFetch(withLaunch(["--other"])),
			unpack: fakeUnpack,
		});
		assert.deepEqual(launchConfigFor(again.bin).args, ["--uid="], "recorded args describe THIS build");
	});

	test("launchConfigFor: no record or a corrupt one launches bare", () => {
		const root = tmpDir();
		const bin = path.join(root, "1.2.3", "agy_acp_server.par");
		fs.mkdirSync(path.dirname(bin), { recursive: true });
		fs.writeFileSync(bin, "");
		assert.deepEqual(launchConfigFor(bin), { build: "", args: [], env: {} });

		fs.writeFileSync(path.join(path.dirname(bin), "launch.json"), "{not json");
		assert.deepEqual(launchConfigFor(bin), { build: "", args: [], env: {} });
	});
});
