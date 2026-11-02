// Process-cleanup and abort regressions (audit 2026-11).
//
// S5: the deferred SIGKILL that follows the graceful window must not keep the
//     event loop alive.
// S6: signal cleanup installs only when the host owns nothing, and a reload
//     replaces this key's handlers instead of stacking another set.
// S7: a bridge call whose abort signal is already aborted is rejected, never
//     parked (its abort listener could never fire).
//
// Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import { installProcessCleanup } from "../src/process-cleanup.js";
import { scheduleHardKill } from "../src/acp/connection.js";
import { ToolRoundTrips } from "../src/tool-roundtrips.js";
import type { StreamDriver } from "../src/driver.js";

function install(key: string, hasHost: boolean): void {
	installProcessCleanup(key, {
		exit: () => {},
		signals: { SIGUSR1: () => {}, SIGUSR2: () => {} },
		hasHostListener: () => hasHost,
	});
}

function parkingDriver(): StreamDriver {
	const handle = {
		id: "probe",
		outcome: new Promise<never>(() => {}),
		next: async () => null,
		pushExternal: () => {},
	};
	return {
		get activeHandle() {
			return handle;
		},
		kickIdle: () => {},
		reentry: () => null,
		snapshot: () => ({}),
		close: async () => {},
		run: async () => handle,
	} as unknown as StreamDriver;
}

test("S5 the deferred hard kill does not keep the event loop alive", () => {
	const timer = scheduleHardKill(999_999, () => true, 10);
	assert.equal(timer.hasRef(), false, "an unref'd timer cannot hold pi open");
	clearTimeout(timer);
});

test("S6 no signal handler is installed when the host owns the signal", () => {
	const before = process.listenerCount("SIGUSR1");
	install("test-host-owned", true);
	assert.equal(process.listenerCount("SIGUSR1"), before);
});

test("S6 one handler is installed when nobody owns the signal", () => {
	const before = process.listenerCount("SIGUSR2");
	install("test-nobody-owns", false);
	assert.equal(process.listenerCount("SIGUSR2"), before + 1);
});

test("S6 a reload replaces this key's handlers instead of stacking", () => {
	const exitBefore = process.listenerCount("exit");
	const usrBefore = process.listenerCount("SIGUSR2");
	install("test-reload", false);
	install("test-reload", false);
	install("test-reload", false);
	assert.equal(process.listenerCount("SIGUSR2"), usrBefore + 1, "one live handler after three loads");
	assert.equal(process.listenerCount("exit"), exitBefore + 1, "one exit hook after three loads");
});

test("S7 an already-aborted client signal is rejected, not parked", async () => {
	const rt = new ToolRoundTrips(parkingDriver());
	const ctrl = new AbortController();
	ctrl.abort();
	await assert.rejects(rt.onToolCall("call-1", "read", {}, ctrl.signal), /disconnected/);
	assert.deepEqual(rt.pendingIds, [], "nothing may stay parked");
});
