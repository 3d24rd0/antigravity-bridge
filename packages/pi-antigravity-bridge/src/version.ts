// The bridge's own version, from package.json.
//
// It was hardcoded in the MCP handshake as "1.0.0", so every release would have
// kept announcing the first one to any MCP client that logs serverInfo. Reading
// the manifest at load makes a version bump the single edit, and the fallback
// keeps a handshake alive if the file cannot be read (the version is display
// metadata, never a decision input).

import fs from "node:fs";

const UNKNOWN = "0.0.0-unknown";

/** Package version, or a clearly-invalid placeholder when it is unreadable. */
export function bridgeVersion(): string {
	try {
		const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			const version = (parsed as { version?: unknown }).version;
			if (typeof version === "string" && version.length > 0) return version;
		}
	} catch {
		// Fall through: a missing manifest must not fail the bridge.
	}
	return UNKNOWN;
}
