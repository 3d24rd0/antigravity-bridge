// Keeping the ACP server build current. The layout already supports it (one
// directory per build + a `current` symlink); what these tests pin is the
// decision logic: what build is in use, when an update exists, and that a build
// which does not start never becomes current.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	buildIdFromBinaryPath,
	checkAcpUpdate,
	isManagedBinary,
	latestRegistryBuild,
	probeServerBinary,
	REGISTRY_CACHE_TTL_MS,
	updateAcp,
} from "../src/acp/update.js";

function tmp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A registry-binary entry for `build`, as the registry JSON carries it. */
function registryJson(build: string, platform = "linux-x86_64") {
	return {
		distribution: {
			binary: {
				[platform]: { archive: `https://example.invalid/agy-acp-server-${build}-linux-x86_64.zip`, cmd: "./agy_acp_server.par" },
			},
		},
	};
}

function fakeFetch(build: string, platform = "linux-x86_64"): typeof fetch {
	return (async () => new Response(JSON.stringify(registryJson(build, platform)), { status: 200 })) as unknown as typeof fetch;
}

test("buildIdFromBinaryPath: versioned layout, current link, and everything else", () => {
	const root = tmp("agy-upd-");
	const buildDir = path.join(root, "1.4.1");
	fs.mkdirSync(buildDir, { recursive: true });
	const bin = path.join(buildDir, "agy_acp_server.par");
	fs.writeFileSync(bin, "");
	assert.equal(buildIdFromBinaryPath(bin), "1.4.1");

	fs.symlinkSync("1.4.1", path.join(root, "current"));
	const viaLink = path.join(root, "current", "agy_acp_server.par");
	fs.writeFileSync(viaLink, "");
	assert.equal(buildIdFromBinaryPath(viaLink), "1.4.1", "a path through current resolves to the build");
	assert.equal(buildIdFromBinaryPath("/usr/local/bin/agy_acp_server.par"), null);
	assert.equal(buildIdFromBinaryPath(null), null);
	assert.equal(buildIdFromBinaryPath(undefined), null);
});

test("isManagedBinary: only paths inside the install root are ours to move", () => {
	const root = tmp("agy-upd-");
	assert.equal(isManagedBinary(path.join(root, "1.4.1", "agy_acp_server.par"), root), true);
	assert.equal(isManagedBinary("/opt/custom/agy_acp_server.par", root), false);
	assert.equal(isManagedBinary(path.join(root, "..", "elsewhere", "x.par"), root), false);
	assert.equal(isManagedBinary(null, root), false);
});

test("latestRegistryBuild: caches per platform for hours, and force bypasses it", async () => {
	const root = tmp("agy-upd-");
	const cachePath = path.join(root, "registry.json");
	let calls = 0;
	const counting = (async () => {
		calls += 1;
		return new Response(JSON.stringify(registryJson("1.5.0")), { status: 200 });
	}) as unknown as typeof fetch;

	const first = await latestRegistryBuild({ cachePath, fetchImpl: counting, platform: "linux-x86_64" });
	assert.equal(first.build, "1.5.0");
	assert.equal(calls, 1);

	const cached = await latestRegistryBuild({ cachePath, fetchImpl: counting, platform: "linux-x86_64" });
	assert.equal(cached.build, "1.5.0");
	assert.equal(calls, 1, "a fresh cache must not refetch");

	const forced = await latestRegistryBuild({ cachePath, fetchImpl: counting, platform: "linux-x86_64", force: true });
	assert.equal(forced.build, "1.5.0");
	assert.equal(calls, 2, "force must refetch");

	// Stale cache (older than the TTL) refetches.
	fs.writeFileSync(cachePath, JSON.stringify({ savedAt: Date.now() - REGISTRY_CACHE_TTL_MS - 1, build: "1.4.1", archive: "x", platform: "linux-x86_64" }));
	const stale = await latestRegistryBuild({ cachePath, fetchImpl: counting, platform: "linux-x86_64" });
	assert.equal(stale.build, "1.5.0");
	assert.equal(calls, 3);
});

test("checkAcpUpdate: compares the build in use with the registry", async () => {
	const root = tmp("agy-upd-");
	const cachePath = path.join(root, "registry.json");
	const bin = path.join(root, "1.4.1", "agy_acp_server.par");
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(bin, "");

	const behind = await checkAcpUpdate(bin, { cachePath, fetchImpl: fakeFetch("1.5.0"), platform: "linux-x86_64" });
	assert.deepEqual(behind, { current: "1.4.1", latest: "1.5.0", updateAvailable: true });

	const same = path.join(root, "1.5.0", "agy_acp_server.par");
	fs.mkdirSync(path.dirname(same), { recursive: true });
	fs.writeFileSync(same, "");
	const upToDate = await checkAcpUpdate(same, { cachePath, fetchImpl: fakeFetch("1.5.0"), platform: "linux-x86_64" });
	assert.equal(upToDate.updateAvailable, false);
});

test("updateAcp: up to date means no download at all", async () => {
	const root = tmp("agy-upd-");
	const bin = path.join(root, "1.5.0", "agy_acp_server.par");
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(bin, "");
	let downloaded = 0;
	const res = await updateAcp({
		installRoot: root,
		currentBin: bin,
		platform: "linux-x86_64",
		cachePath: path.join(root, "registry.json"),
		fetchImpl: (async () => {
			downloaded += 1;
			return new Response(JSON.stringify(registryJson("1.5.0")), { status: 200 });
		}) as unknown as typeof fetch,
		unpack: async () => assert.fail("must not unpack when up to date"),
	});
	assert.equal(res.ok, true);
	assert.equal(res.upToDate, true);
	assert.equal(downloaded, 1, "one registry fetch, zero downloads");
});

test("updateAcp: installs, validates, then switches current", async () => {
	const root = tmp("agy-upd-");
	const oldBin = path.join(root, "1.4.1", "agy_acp_server.par");
	fs.mkdirSync(path.dirname(oldBin), { recursive: true });
	fs.writeFileSync(oldBin, "");
	fs.symlinkSync("1.4.1", path.join(root, "current"));

	const res = await updateAcp({
		installRoot: root,
		currentBin: oldBin,
		platform: "linux-x86_64",
		cachePath: path.join(root, "registry.json"),
		fetchImpl: (async () => new Response(JSON.stringify(registryJson("1.5.0")), { status: 200 })) as unknown as typeof fetch,
		// Download bytes are irrelevant: the unpacker places the executable.
		unpack: async (_archive, dest) => {
			fs.writeFileSync(path.join(dest, "agy_acp_server.par"), "", { mode: 0o755 });
		},
		validate: async (bin) => fs.existsSync(bin),
	});
	assert.equal(res.ok, true, JSON.stringify(res));
	assert.equal(res.from, "1.4.1");
	assert.equal(res.to, "1.5.0");
	assert.equal(path.basename(fs.readlinkSync(path.join(root, "current"))), "1.5.0", "current must follow a validated build");
	assert.ok(fs.existsSync(oldBin), "the previous build is kept for rollback");
});

test("updateAcp: a build that does not start never becomes current", async () => {
	const root = tmp("agy-upd-");
	const oldBin = path.join(root, "1.4.1", "agy_acp_server.par");
	fs.mkdirSync(path.dirname(oldBin), { recursive: true });
	fs.writeFileSync(oldBin, "");
	fs.symlinkSync("1.4.1", path.join(root, "current"));

	const res = await updateAcp({
		installRoot: root,
		currentBin: oldBin,
		platform: "linux-x86_64",
		cachePath: path.join(root, "registry.json"),
		fetchImpl: (async () => new Response(JSON.stringify(registryJson("1.5.0")), { status: 200 })) as unknown as typeof fetch,
		unpack: async (_archive, dest) => {
			fs.writeFileSync(path.join(dest, "agy_acp_server.par"), "", { mode: 0o755 });
		},
		validate: async () => false,
	});
	assert.equal(res.ok, false);
	assert.equal(res.validationFailed, true);
	assert.match(res.error ?? "", /still current/);
	assert.equal(path.basename(fs.readlinkSync(path.join(root, "current"))), "1.4.1", "current must not move");
});

test("updateAcp: an unreachable registry is an error, not a crash", async () => {
	const res = await updateAcp({
		cachePath: path.join(tmp("agy-upd-"), "registry.json"),
		fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
	});
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /registry/);
});

test("probeServerBinary: launches with the build's recorded args, not bare", async () => {
	// The validator must launch the build the way turns will, or Linux would be
	// validated bare and then abort on the `nobody` group at the first turn.
	const dir = tmp("agy-upd-");
	const buildDir = path.join(dir, "1.5.0");
	fs.mkdirSync(buildDir, { recursive: true });
	const argvFile = path.join(dir, "argv.txt");
	const bin = path.join(buildDir, "agy_acp_server.par");
	fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$*" > '${argvFile}'\nexit 1\n`, { mode: 0o755 });
	fs.writeFileSync(
		path.join(buildDir, "launch.json"),
		JSON.stringify({ build: "1.5.0", args: ["--uid="], env: { AGY_PROBE_ENV: "1" } }),
	);
	assert.equal(await probeServerBinary(bin, dir), false, "no protocol answer, so validation fails");
	assert.equal(fs.readFileSync(argvFile, "utf8").trim(), "--uid=", "the declared args reached the process");
});
