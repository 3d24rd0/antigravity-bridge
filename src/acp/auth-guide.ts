// Guided sign-in for the ACP engine.
//
// The sign-in itself is one RPC, but the *route* to it depends on where the
// user is sitting: a desktop opens the browser and that is the whole story,
// while a bare SSH session needs the Google URL carried to another machine and
// the loopback redirect port forwarded back. Discovering that after the fact
// means running other commands to find out what is happening, which is exactly
// what this module removes: detect the situation, say what will happen, offer
// the options in the flow, and interpret a failure into a next step.
//
// Everything here is pure: it takes an env snapshot and returns text. The
// command handler owns the dialogs and the actual sign-in.

import os from "node:os";
import path from "node:path";

export type AuthMode = "browser" | "tunnel" | "api-key";

/** Where the BROWSER wrapper records the sign-in URL: the durable copy, since
 *  the notice is one-shot and the flow blocks. */
export const AUTH_URL_FILE_HINT = path.join(
	os.homedir(),
	".pi",
	"agent",
	"antigravity-bridge",
	"acp-auth-urls.log",
);

export interface AuthEnvironment {
	/** A desktop session can open a browser. */
	hasGui: boolean;
	/** Running inside an SSH session. */
	remote: boolean;
	/** An opener binary was found on PATH (only checked where it matters). */
	hasOpener: boolean;
	platform: NodeJS.Platform;
	/** Login name for the tunnel recipe. */
	user: string;
	/** Hostname for the tunnel recipe. */
	host: string;
}

/** Snapshot the environment. `env`/`platform`/`hasOpener` are injectable so the
 *  decision table is testable without touching the real machine. */
export function detectAuthEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	hasOpener = true,
): AuthEnvironment {
	const hasGui =
		platform === "darwin" || platform === "win32"
			? true
			: Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
	const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
	let user = env.USER || env.LOGNAME || "";
	if (!user) {
		try {
			user = os.userInfo().username;
		} catch {
			user = "user";
		}
	}
	let host = "";
	try {
		host = os.hostname();
	} catch {
		host = "host";
	}
	return { hasGui, remote, hasOpener, platform, user, host };
}

/** Options offered when the route is genuinely ambiguous. A desktop session is
 *  not ambiguous: opening the browser is the answer and a menu would only add a
 *  step. */
export function authChoice(env: AuthEnvironment): { title: string; options: AuthMode[] } | null {
	if (env.hasGui && env.hasOpener) return null;
	return { title: "How should this machine sign in to Antigravity?", options: ["tunnel", "api-key"] };
}

/** One line describing the option, for the selector. */
export function authModeLabel(mode: AuthMode, env: AuthEnvironment): string {
	switch (mode) {
		case "browser":
			return "Open the browser here (fastest)";
		case "tunnel":
			return "Give me the URL + exact ssh tunnel command";
		case "api-key":
			return "Use a Gemini API key instead (paid API, not your plan)";
	}
}

/** What is about to happen, in order, before the blocking sign-in starts. Lines
 *  are user-facing and state the wait budget so nobody sits guessing. */
export function authStepGuide(
	mode: AuthMode,
	env: AuthEnvironment,
	method?: { name: string; description?: string },
): string[] {
	const lines: string[] = [];
	if (mode === "api-key") {
		// Credential methods (Gemini API key, Agent Platform/ADC) never open a
		// page: the server authenticates from something already on the machine.
		lines.push(`${method?.name ?? "Credential"} sign-in:`);
		if (method?.description) lines.push(`  ${method.description}`);
		lines.push(
			"  1. Make the credential available to the process that runs pi:",
			"     - Gemini API key: export GEMINI_API_KEY",
			"     - Agent Platform: gcloud auth application-default login (ADC), or an API key",
			"  2. Run /agy auth again, then /reload",
			"",
			"This is metered API billing, not your Antigravity subscription.",
		);
		return lines;
	}
	if (mode === "browser") {
		lines.push("Signing in with your Google account. What happens:");
		lines.push("  1. Your browser opens the Google sign-in page.");
		lines.push("  2. You finish it there; this command waits up to 10 minutes.");
		lines.push("  3. If no browser opens, the URL appears here with a copy-paste fallback.");
		return lines;
	}
	lines.push("Signing in from a terminal without a browser. What happens:");
	lines.push("  1. Google's sign-in URL appears here as soon as the server produces it.");
	lines.push("  2. Copy that URL and paste it into a browser on a machine you can see.");
	lines.push("  3. Before the browser finishes, run the ssh tunnel command printed next to the URL.");
	lines.push(`     (it forwards the loopback port back to ${env.host}; this command waits up to 10 minutes)`);
	lines.push("  4. Come back here: the sign-in completes on its own when the redirect lands.");
	lines.push("");
	lines.push(`Lost the URL? It is also saved in ${AUTH_URL_FILE_HINT}`);
	return lines;
}

/** The exact tunnel recipe for a discovered loopback port, with this machine's
 *  real user and hostname instead of a placeholder. */
export function tunnelCommand(port: number, env: AuthEnvironment): string {
	return `ssh -N -L ${port}:127.0.0.1:${port} ${env.user}@${env.host}`;
}

/** Recovery block for a failure that already captured a URL: the page may
 *  still be open, and the person needs the link plus the tunnel again without
 *  hunting for a command. */
export function authRecovery(env: AuthEnvironment, url: string, port: number | null): string[] {
	const lines = ["Sign-in URL (reopen it with the tunnel up, then finish the page):", "", url];
	if (port) lines.push("", `  ${tunnelCommand(port, env)}`);
	lines.push("", `Also saved in ${AUTH_URL_FILE_HINT}`);
	return lines;
}

/** Turn a sign-in failure into something the user can act on. */
export function authFailureHint(error: string): string {
	const e = error.toLowerCase();
	if (e.includes("already running")) return "A sign-in is already in progress. Finish it in the browser, then retry.";
	if (e.includes("timed out") || e.includes("timeout")) {
		return "The browser step never completed. Run /agy auth-url to reopen the link, and make sure the ssh tunnel is up before the page redirects.";
	}
	if (e.includes("no usable credentials")) {
		return "The server accepted the sign-in but kept no usable credentials. Finish the Google page if it is still open, then run /agy auth again.";
	}
	if (e.includes("unsupported auth method")) {
		return "This build of the server does not offer that method. /agy auth lists the ones it does, and /agy doctor shows the server version.";
	}
	if (e.includes("agent platform authentication")) {
		return "Agent Platform needs its own credentials: GOOGLE_API_KEY, or GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION (or gcp.project and gcp.location in the server's settings.json). This is not your Antigravity subscription.";
	}
	if ((e.includes("api key") || e.includes("api_key")) && (e.includes("must be set") || e.includes("missing"))) {
		return "That method needs a credential the server cannot see. Export GEMINI_API_KEY (or configure it in the server's settings.json), then run /agy auth again.";
	}
	if (e.includes("could not") && e.includes("binar")) {
		return "The server binary is missing or unreadable. /agy doctor shows the path; /agy acp-bin auto re-runs setup.";
	}
	return "Retry with /agy auth. /agy doctor shows server state, and /agy auth-manual has the full manual route.";
}
