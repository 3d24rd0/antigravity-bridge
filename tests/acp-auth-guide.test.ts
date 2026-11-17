// Guided sign-in: the route to Google's OAuth depends on where the user is
// sitting, and getting it wrong costs a 10-minute wait plus a hunt through
// commands. These tests pin the decision table, the guide text and the tunnel
// recipe (real user/host, no placeholder).

import assert from "node:assert/strict";
import { test } from "vitest";
import {
	AUTH_URL_FILE_HINT,
	authChoice,
	authFailureHint,
	authModeLabel,
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

test("authChoice: a desktop session is offered no menu", () => {
	assert.equal(authChoice(env({ hasGui: true, hasOpener: true })), null);
});

test("authChoice: no browser (or no opener) offers the two real options", () => {
	assert.deepEqual(authChoice(env()), { title: "How should this machine sign in to Antigravity?", options: ["tunnel", "api-key"] });
	assert.deepEqual(authChoice(env({ hasGui: true, hasOpener: false }))?.options, ["tunnel", "api-key"]);
});

test("authStepGuide: the tunnel route says what to do, in order, with the wait budget", () => {
	const lines = authStepGuide("tunnel", env()).join("\n");
	assert.match(lines, /URL appears here/);
	assert.match(lines, /paste it into a browser/);
	assert.match(lines, /ssh tunnel command/);
	assert.match(lines, /up to 10 minutes/);
	assert.match(lines, /buildbox/);
});

test("authStepGuide: the browser route does not mention tunnels", () => {
	const lines = authStepGuide("browser", env({ hasGui: true })).join("\n");
	assert.match(lines, /browser opens/);
	assert.doesNotMatch(lines, /ssh/);
});

test("authStepGuide: the API-key route is labelled as not the subscription", () => {
	const lines = authStepGuide("api-key", env()).join("\n");
	assert.match(lines, /gemini-api-key/);
	assert.match(lines, /GEMINI_API_KEY/);
	assert.match(lines, /not your Antigravity subscription/);
});

test("tunnelCommand: uses the real user and host, never a placeholder", () => {
	const cmd = tunnelCommand(41234, env({ user: "ana", host: "buildbox" }));
	assert.equal(cmd, "ssh -N -L 41234:127.0.0.1:41234 ana@buildbox");
	assert.doesNotMatch(cmd, /<user@host>/);
});

test("authModeLabel: every mode explains itself", () => {
	for (const mode of ["browser", "tunnel", "api-key"] as const) {
		assert.ok(authModeLabel(mode, env()).length > 10, mode);
	}
	assert.match(authModeLabel("api-key", env()), /not your plan/);
});

test("authFailureHint: maps the common failures onto a next step", () => {
	assert.match(authFailureHint("a sign-in is already running; wait for it to finish"), /already in progress/);
	assert.match(authFailureHint("request timed out after 600000ms"), /auth-url/);
	assert.match(authFailureHint("the server accepted the sign-in but holds no usable credentials"), /run \/agy auth again/);
	assert.match(authFailureHint("spawn ENOENT"), /\/agy doctor/);
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
