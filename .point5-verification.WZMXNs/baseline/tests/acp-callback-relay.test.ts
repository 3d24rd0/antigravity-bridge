// Remote `/agy auth` without an SSH tunnel (spec S4). The browser's final
// redirect lands on a loopback listener the remote machine owns, so a pasted
// URL is enough once it is proven to be loopback-on-the-expected-port: anything
// else would let the paste act as a general-purpose HTTP client on the user's
// behalf. These tests pin the validation table, the real single-shot relay, and
// the interactive retry loop. Network is local only (ephemeral 127.0.0.1:0).

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "vitest";
import {
	relayLoopbackCallback,
	runCallbackPasteLoop,
	validateLoopbackCallbackUrl,
} from "../src/acp/callback-relay.js";

const PORT = 41234;

const servers: http.Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections?.();
					server.close(() => resolve());
				}),
		),
	);
});

/** A real loopback listener that records the request URLs it receives. */
async function listen(): Promise<{ port: number; hits: string[] }> {
	const hits: string[] = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url ?? "");
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: (server.address() as AddressInfo).port, hits };
}

describe("acp/callback-relay validateLoopbackCallbackUrl: rejects", () => {
	const rejected: Array<[string, string, number]> = [
		["empty", "", PORT],
		["whitespace only", "   ", PORT],
		["malformed", "not a url", PORT],
		["scheme-less", "127.0.0.1:41234/callback", PORT],
		["https", "https://127.0.0.1:41234/callback?code=abc", PORT],
		["file", "file:///etc/passwd", PORT],
		["javascript", "javascript:alert(1)", PORT],
		["external domain", "http://example.com:41234/callback", PORT],
		["private LAN ip", "http://192.168.1.5:41234/callback", PORT],
		["private LAN ip (10/8)", "http://10.0.0.1:41234/callback", PORT],
		["wildcard bind", "http://0.0.0.0:41234/callback", PORT],
		["other loopback alias", "http://127.0.0.2:41234/callback", PORT],
		["wrong port", "http://127.0.0.1:41235/callback", PORT],
		["missing port", "http://127.0.0.1/callback", PORT],
		["credentials in URL", "http://user:secret@127.0.0.1:41234/callback", PORT],
		["username only", "http://user@127.0.0.1:41234/callback", PORT],
		["expectedPort 0", "http://127.0.0.1:41234/callback", 0],
		["expectedPort out of range", "http://127.0.0.1:41234/callback", 65536],
		["expectedPort not an integer", "http://127.0.0.1:41234/callback", 41234.5],
		["expectedPort NaN", "http://127.0.0.1:41234/callback", Number.NaN],
	];

	for (const [label, raw, port] of rejected) {
		test(`${label} -> { ok: false, reason }`, () => {
			const result = validateLoopbackCallbackUrl(raw, port);
			assert.equal(result.ok, false, `${label} should be rejected`);
			if (result.ok) return;
			assert.equal(typeof result.reason, "string");
			assert.ok(result.reason.length > 0, "a rejection must explain itself");
		});
	}
});

describe("acp/callback-relay validateLoopbackCallbackUrl: accepts", () => {
	test("127.0.0.1 keeps the exact pathname and query", () => {
		const result = validateLoopbackCallbackUrl("http://127.0.0.1:41234/callback?code=abc&state=xyz", PORT);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.targetUrl, "http://127.0.0.1:41234/callback?code=abc&state=xyz");
		assert.ok(result.url instanceof URL);
		assert.equal(result.url.searchParams.get("code"), "abc");
	});

	test("localhost and [::1] normalize onto 127.0.0.1", () => {
		for (const host of ["localhost", "[::1]"]) {
			const result = validateLoopbackCallbackUrl(`http://${host}:41234/cb?code=abc`, PORT);
			assert.equal(result.ok, true, host);
			if (!result.ok) continue;
			assert.equal(result.targetUrl, "http://127.0.0.1:41234/cb?code=abc", host);
		}
	});

	test("a fragment is dropped from the forwarded target", () => {
		const result = validateLoopbackCallbackUrl("http://127.0.0.1:41234/callback?code=abc#access_token=leak", PORT);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.targetUrl, "http://127.0.0.1:41234/callback?code=abc");
	});

	test("surrounding whitespace from a paste is tolerated", () => {
		const result = validateLoopbackCallbackUrl("  http://127.0.0.1:41234/callback?code=abc  ", PORT);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.targetUrl, "http://127.0.0.1:41234/callback?code=abc");
	});
});

describe("acp/callback-relay relayLoopbackCallback against a real listener", () => {
	test("forwards the exact pathname + query and reports the status", async () => {
		const { port, hits } = await listen();
		const result = await relayLoopbackCallback(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`, port);
		assert.deepEqual(result, { ok: true, statusCode: 200 });
		assert.deepEqual(hits, ["/callback?code=abc&state=xyz"]);
	});

	test("localhost is normalized before the request is made", async () => {
		const { port, hits } = await listen();
		const result = await relayLoopbackCallback(`http://localhost:${port}/cb?code=abc`, port);
		assert.deepEqual(result, { ok: true, statusCode: 200 });
		assert.deepEqual(hits, ["/cb?code=abc"]);
	});

	test("a mismatched port never reaches the listener", async () => {
		const { port, hits } = await listen();
		const result = await relayLoopbackCallback(`http://127.0.0.1:${port + 1}/callback?code=abc`, port);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.reason, new RegExp(String(port + 1)));
		assert.deepEqual(hits, []);
	});

	test("a non-loopback host never reaches the listener", async () => {
		const { port, hits } = await listen();
		for (const host of ["10.0.0.1", "0.0.0.0", "127.0.0.2", "example.com"]) {
			const result = await relayLoopbackCallback(`http://${host}:${port}/callback?code=abc`, port);
			assert.equal(result.ok, false, host);
		}
		assert.deepEqual(hits, []);
	});

	test("a closed port returns { ok: false, reason }", async () => {
		const { port } = await listen();
		const dead = http.createServer();
		await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
		const deadPort = (dead.address() as AddressInfo).port;
		await new Promise<void>((resolve) => dead.close(() => resolve()));
		assert.notEqual(deadPort, port);
		const result = await relayLoopbackCallback(`http://127.0.0.1:${deadPort}/callback?code=abc`, deadPort);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.ok(result.reason.length > 0);
	});

	test("a listener that never answers hits the relay timeout", async () => {
		// Accepts the connection and holds it open: only the timeout can end it.
		const hang = http.createServer(() => {
			/* never respond */
		});
		servers.push(hang);
		await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
		const hangPort = (hang.address() as AddressInfo).port;
		const result = await relayLoopbackCallback(`http://127.0.0.1:${hangPort}/callback?code=abc`, hangPort, { timeoutMs: 200 });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.reason, /timed out|timeout/i);
	});
});

describe("acp/callback-relay runCallbackPasteLoop", () => {
	type Call = { msg: string; level: "info" | "warning" };

	const harness = (answers: Array<string | undefined>) => {
		const prompts: string[] = [];
		const calls: Call[] = [];
		const relayed: Array<{ url: string; port: number }> = [];
		let index = 0;
		return {
			prompts,
			calls,
			relayed,
			opts: {
				port: PORT,
				signal: new AbortController().signal,
				isSettled: () => false,
				prompt: async (title: string) => {
					prompts.push(title);
					return answers[index++];
				},
				notify: (msg: string, level: "info" | "warning") => calls.push({ msg, level }),
				relay: async (url: string, port: number) => {
					relayed.push({ url, port });
					return url.includes("code=good")
						? { ok: true as const, statusCode: 200 }
						: { ok: false as const, reason: "the callback URL must use http:, not https:" };
				},
			},
		};
	};

	test("an invalid paste warns, loops, then relays the fixed URL", async () => {
		const h = harness(["https://evil.example/callback", `http://127.0.0.1:${PORT}/callback?code=good`]);
		await runCallbackPasteLoop(h.opts);
		assert.equal(h.prompts.length, 2, "the loop must ask again after a rejection");
		assert.deepEqual(
			h.calls.map((c) => c.level),
			["warning", "info"],
		);
		assert.match(h.calls[0].msg, /https:/);
		assert.match(h.calls[1].msg, /forwarded/i);
		assert.deepEqual(h.relayed, [
			{ url: "https://evil.example/callback", port: PORT },
			{ url: `http://127.0.0.1:${PORT}/callback?code=good`, port: PORT },
		]);
	});

	test("Esc (undefined) and a blank answer both exit cleanly with no warning", async () => {
		for (const answer of [undefined, "", "   "]) {
			const h = harness([answer]);
			await runCallbackPasteLoop(h.opts);
			assert.equal(h.prompts.length, 1, String(answer));
			assert.deepEqual(h.relayed, [], String(answer));
			assert.deepEqual(h.calls, [], String(answer));
		}
	});

	test("an already-aborted signal never prompts", async () => {
		const h = harness([`http://127.0.0.1:${PORT}/callback?code=good`]);
		const controller = new AbortController();
		controller.abort();
		await runCallbackPasteLoop({ ...h.opts, signal: controller.signal });
		assert.equal(h.prompts.length, 0);
		assert.deepEqual(h.relayed, []);
	});

	test("a settled auth exits the loop instead of asking again", async () => {
		const h = harness([`http://127.0.0.1:${PORT}/callback?code=bad`, `http://127.0.0.1:${PORT}/callback?code=good`]);
		let settled = false;
		await runCallbackPasteLoop({
			...h.opts,
			isSettled: () => settled,
			relay: async (url: string, port: number) => {
				h.relayed.push({ url, port });
				settled = true; // the tunnel completed while the paste was in flight
				return { ok: false as const, reason: "connection refused" };
			},
		});
		assert.equal(h.prompts.length, 1);
		assert.deepEqual(h.calls, [], "a settled auth must not nag about the rejected paste");
	});

	test("an abort while the dialog is open exits without prompting again", async () => {
		const controller = new AbortController();
		const h = harness(["should never be used"]);
		await runCallbackPasteLoop({
			...h.opts,
			signal: controller.signal,
			prompt: async () => {
				controller.abort();
				return `http://127.0.0.1:${PORT}/callback?code=good`;
			},
		});
		assert.deepEqual(h.relayed, [], "an aborted dialog must not relay");
		assert.deepEqual(h.calls, []);
	});
});
