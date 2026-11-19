// Remote `/agy auth` without an SSH tunnel (spec S4).
//
// The Google sign-in always redirects to a loopback listener owned by the ACP
// server on the machine running Pi. On a bare SSH session the classic route is
// forwarding that port (`ssh -L`), which needs a second terminal and a tunnel
// that is up *before* the browser finishes. A pasted redirect URL is the
// cheaper route: the browser on the user's machine still performs the redirect,
// they copy the final address, and this module replays that single request
// locally so the server sees the callback and completes OAuth.
//
// A pasted URL is untrusted input, so the replay is deliberately narrow: http:
// only, loopback only, the exact port the active auth attempt is waiting on, no
// credentials, and a single GET with no redirect following. A malformed or
// hostile paste never reaches the network at all.

import http from "node:http";

/** One pasted callback attempt is a human action: five seconds is long enough
 *  for a local listener and short enough not to feel hung. */
const DEFAULT_RELAY_TIMEOUT_MS = 5_000;

/** Exact loopback spellings. Anything else (a LAN address, 0.0.0.0,
 *  127.0.0.2, an external domain) is refused: the replay must never act as a
 *  general-purpose HTTP client for a pasted string. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type CallbackUrlValidation = { ok: true; url: URL; targetUrl: string } | { ok: false; reason: string };

export type CallbackRelayResult = { ok: true; statusCode: number } | { ok: false; reason: string };

function isPort(value: number): boolean {
	return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Validate a pasted browser redirect URL against the port the active auth
 *  attempt is waiting on, and normalize it into the URL to replay.
 *
 *  The returned `targetUrl` is rebuilt from scratch (`127.0.0.1` + expected
 *  port + pathname + query) instead of reusing the pasted string, so userinfo
 *  (`http://user:secret@127.0.0.1:...`) and fragments can never reach the
 *  request, even if a future parser change stops rejecting them. */
export function validateLoopbackCallbackUrl(rawUrl: string, expectedPort: number): CallbackUrlValidation {
	if (!isPort(expectedPort)) {
		return { ok: false, reason: `the waiting callback port must be an integer between 1 and 65535 (got ${String(expectedPort)})` };
	}
	const raw = typeof rawUrl === "string" ? rawUrl.trim() : "";
	if (!raw) return { ok: false, reason: "no callback URL was pasted" };
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: `that is not a valid URL: ${raw}` };
	}
	if (url.protocol !== "http:") {
		return { ok: false, reason: `the callback URL must use http:, not ${url.protocol}` };
	}
	if (url.username || url.password) {
		return { ok: false, reason: "the callback URL must not carry a username or password" };
	}
	const host = url.hostname.toLowerCase();
	if (!LOOPBACK_HOSTS.has(host)) {
		return {
			ok: false,
			reason: `the callback URL must point at the loopback interface (127.0.0.1, localhost or [::1]), not ${host}`,
		};
	}
	if (!url.port) {
		return { ok: false, reason: `the callback URL must carry the explicit port ${expectedPort}` };
	}
	if (Number(url.port) !== expectedPort) {
		return { ok: false, reason: `the callback URL port ${url.port} does not match the waiting callback port ${expectedPort}` };
	}
	return { ok: true, url, targetUrl: `http://127.0.0.1:${expectedPort}${url.pathname}${url.search}` };
}

/** Replay one validated callback request against the local listener.
 *
 *  A single GET, no redirect following (the point is to hit the listener, not
 *  to follow where it points), the response drained so the server can finish
 *  its reply, and a short timeout because the listener answers immediately when
 *  it is the right one. Validation happens first: invalid input performs no
 *  network I/O at all. */
export function relayLoopbackCallback(
	rawUrl: string,
	expectedPort: number,
	opts: { timeoutMs?: number } = {},
): Promise<CallbackRelayResult> {
	const valid = validateLoopbackCallbackUrl(rawUrl, expectedPort);
	if (!valid.ok) return Promise.resolve({ ok: false, reason: valid.reason });
	const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_RELAY_TIMEOUT_MS;
	return new Promise<CallbackRelayResult>((resolve) => {
		let settled = false;
		const finish = (result: CallbackRelayResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		let req: http.ClientRequest;
		try {
			req = http.request(valid.targetUrl, { method: "GET", timeout: timeoutMs }, (res) => {
				res.resume(); // drain: the listener needs its write to complete
				res.on("end", () => finish({ ok: true, statusCode: res.statusCode ?? 0 }));
				res.on("error", (err) =>
					finish({ ok: false, reason: `the local callback listener dropped the response: ${err instanceof Error ? err.message : String(err)}` }),
				);
			});
		} catch (err) {
			return finish({ ok: false, reason: `could not build the callback request: ${err instanceof Error ? err.message : String(err)}` });
		}
		req.on("timeout", () => {
			req.destroy();
			finish({ ok: false, reason: `the local callback listener timed out after ${timeoutMs}ms` });
		});
		req.on("error", (err) =>
			finish({ ok: false, reason: `could not reach the local callback listener: ${err instanceof Error ? err.message : String(err)}` }),
		);
		req.end();
	});
}

export interface CallbackPasteLoopOptions {
	/** Port the active auth attempt is listening on. */
	port: number;
	/** The host's text dialog. Resolves `undefined` when dismissed (Esc). */
	prompt: (title: string, placeholder: string, signal: AbortSignal) => Promise<string | undefined>;
	notify: (msg: string, level: "info" | "warning") => void;
	signal: AbortSignal;
	/** True once the blocking sign-in has finished (success, error or timeout):
	 *  the loop must stop instead of asking again. */
	isSettled: () => boolean;
	/** Injectable for tests; production uses the real relay. */
	relay?: typeof relayLoopbackCallback;
}

const PASTE_TITLE = "Paste the browser's final redirect URL (http://127.0.0.1:<port>/…)";
const PASTE_PLACEHOLDER = "http://127.0.0.1:<port>/… then Enter (Esc to skip)";

/** Interactive retry loop for the pasted-callback route.
 *
 *  Runs alongside the blocking `authenticate` RPC: a rejected paste warns with
 *  the reason and asks again while auth is still waiting (a typo should not cost
 *  the whole sign-in), a blank answer or Esc ends the dialog quietly, and an
 *  abort or settled auth stops the loop without a stray warning. Never throws:
 *  it is a side-channel to a sign-in that reports its own outcome. */
export async function runCallbackPasteLoop(opts: CallbackPasteLoopOptions): Promise<void> {
	const relay = opts.relay ?? relayLoopbackCallback;
	const stopped = (): boolean => opts.signal.aborted || opts.isSettled();
	while (!stopped()) {
		let answer: string | undefined;
		try {
			answer = await opts.prompt(PASTE_TITLE, PASTE_PLACEHOLDER, opts.signal);
		} catch (err) {
			// A dismissed dialog rejects in some hosts: quiet when that is the
			// cause, one warning when the host genuinely failed to read input.
			if (stopped()) return;
			opts.notify(`Could not read the pasted URL: ${err instanceof Error ? err.message : String(err)}`, "warning");
			return;
		}
		if (stopped()) return;
		const input = (answer ?? "").trim();
		if (!input) return; // Esc / cancel / blank: the tunnel route stays available
		const result = await relay(input, opts.port);
		// Auth can finish (tunnel completed, error, timeout) while the replay is in
		// flight; then the paste is moot and a warning would contradict the result.
		if (stopped()) return;
		if (result.ok) {
			opts.notify(
				`Callback forwarded to the local listener (HTTP ${result.statusCode}). The sign-in completes on its own; this command reports the outcome.`,
				"info",
			);
			return;
		}
		opts.notify(`That URL cannot complete the sign-in: ${result.reason}`, "warning");
	}
}
