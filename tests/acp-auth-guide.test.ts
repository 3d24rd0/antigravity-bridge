// Guided sign-in: the route to Google's OAuth depends on where the user is
// sitting, and getting it wrong costs a 10-minute wait plus a hunt through
// commands. These tests pin the decision table, the guide text and the tunnel
// recipe (real user/host, no placeholder).

import assert from "node:assert/strict";
import { test } from "vitest";
import {
	AUTH_URL_FILE_HINT,
	authFailureHint,
	authRecovery,
	authStepGuide,
	detectAuthEnvironment,
	tunnelCommand,
} from "../src/acp/auth-guide.js";

const env = (over: Partial<{ hasGui: boolean; remote: boolean; hasOpener: boolean; user: string; host: string }> = {}) => ({
	hasGui: false,
	remote: false,
	hasOpener: true,
	platform: "linux" as const,
	user: "ana",
	host: "buildbox",
	...over,
});

test("detectAuthEnvironment: macOS and Windows count as having a browser", () => {
	assert.equal(detectAuthEnvironment({}, "darwin").hasGui, true);
	assert.equal(detectAuthEnvironment({}, "win32").hasGui, true);
});

test("detectAuthEnvironment: Linux needs a display server", () => {
	assert.equal(detectAuthEnvironment({}, "linux").hasGui, false);
	assert.equal(detectAuthEnvironment({ DISPLAY: ":0" }, "linux").hasGui, true);
	assert.equal(detectAuthEnvironment({ WAYLAND_DISPLAY: "wayland-0" }, "linux").hasGui, true);
});

test("detectAuthEnvironment: any SSH marker counts as remote", () => {
	for (const key of ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]) {
		assert.equal(detectAuthEnvironment({ [key]: "x" }, "linux").remote, true, key);
	}
	assert.equal(detectAuthEnvironment({}, "linux").remote, false);
});

test("authStepGuide: the tunnel route says what to do, in order, with the wait budget", () => {
	const lines = authStepGuide("tunnel", env()).join("\n");
	assert.match(lines, /URL appears here/);
	assert.match(lines, /paste it into a browser/);
	assert.match(lines, /ssh tunnel command/);
	assert.match(lines, /up to 10 minutes/);
	assert.match(lines, /buildbox/);
});

test("authStepGuide: the tunnel route offers the pasted-callback fallback, so no ssh tunnel is strictly required", () => {
	const lines = authStepGuide("tunnel", env()).join("\n");
	assert.match(lines, /No ssh tunnel/);
	assert.match(lines, /paste the browser's final redirect URL/);
	// The tunnel stays the first suggestion; the fallback is an addition.
	assert.match(lines, /ssh tunnel command/);
});

test("authStepGuide: the browser route does not mention the pasted-callback fallback", () => {
	const lines = authStepGuide("browser", env({ hasGui: true })).join("\n");
	assert.doesNotMatch(lines, /redirect URL/);
	assert.doesNotMatch(lines, /No ssh tunnel/);
});

test("authStepGuide: the browser route does not mention tunnels", () => {
	const lines = authStepGuide("browser", env({ hasGui: true })).join("\n");
	assert.match(lines, /browser opens/);
	assert.doesNotMatch(lines, /ssh/);
});

test("tunnelCommand: uses the real user and host, never a placeholder", () => {
	const cmd = tunnelCommand(41234, env({ user: "ana", host: "buildbox" }));
	assert.equal(cmd, "ssh -N -L 41234:127.0.0.1:41234 ana@buildbox");
	assert.doesNotMatch(cmd, /<user@host>/);
});

test("authFailureHint: maps the common failures onto a next step", () => {
	assert.match(authFailureHint("a sign-in is already running; wait for it to finish"), /already in progress/);
	assert.match(authFailureHint("the server accepted the sign-in but holds no usable credentials"), /run \/agy auth again/);
	assert.match(authFailureHint("spawn ENOENT"), /\/agy doctor/);
	assert.match(authFailureHint("Unsupported auth method: 'x'"), /does not offer that method/);
	assert.match(
		authFailureHint("GOOGLE_API_KEY, or a project and location from GOOGLE_CLOUD_PROJECT ... must be set for Agent Platform authentication."),
		/not your Antigravity subscription/,
	);
	assert.match(authFailureHint("GEMINI_API_KEY must be set"), /Export GEMINI_API_KEY/);
});

test("authFailureHint: a timeout points at /agy auth and the saved URLs, never the dead /agy auth-url", () => {
	const hint = authFailureHint("request timed out after 600000ms");
	assert.match(hint, /\/agy auth again/);
	assert.ok(hint.includes(AUTH_URL_FILE_HINT));
	assert.match(hint, /acp-auth-urls\.log/);
	assert.match(hint, /ssh tunnel/);
	assert.doesNotMatch(hint, /\/agy auth-url/);
});

test("authStepGuide: both routes warn that the page after approving is not the outcome", () => {
	for (const mode of ["browser", "tunnel"] as const) {
		const lines = authStepGuide(mode, env({ hasGui: mode === "browser" })).join("\n");
		assert.match(lines, /empty page/, mode);
		assert.match(lines, /connection reset/, mode);
		assert.match(lines, /one-shot callback listener closes/, mode);
		assert.match(lines, /Pi command result/, mode);
	}
});

test("authStepGuide: the tunnel route names the saved copy, so no command is needed to recover it", () => {
	const lines = authStepGuide("tunnel", env()).join("\n");
	assert.match(lines, /Lost the URL/);
	assert.ok(lines.includes(AUTH_URL_FILE_HINT));
	assert.match(AUTH_URL_FILE_HINT, /acp-auth-urls\.log$/);
});

test("authRecovery: hands back the URL and the tunnel command, no extra command to learn", () => {
	const lines = authRecovery(env({ user: "ana", host: "buildbox" }), "https://accounts.google.com/o/oauth2/v2/auth?x=1", 41234).join("\n");
	assert.match(lines, /https:\/\/accounts\.google\.com/);
	assert.ok(lines.includes("ssh -N -L 41234:127.0.0.1:41234 ana@buildbox"));
	assert.ok(lines.includes(AUTH_URL_FILE_HINT));
});

test("authRecovery: a URL without a loopback port still returns the link", () => {
	const lines = authRecovery(env(), "https://example.invalid/auth", null).join("\n");
	assert.match(lines, /example\.invalid/);
	assert.doesNotMatch(lines, /ssh -N -L/);
});
