// Sign-in methods the ACP server itself advertises.
//
// The server answers `initialize` with an `authMethods` list, and that list is
// the only honest source of what an account can use. Verified live against
// agy_acp_server 1.4.1 (2026-11), which publishes four:
//
//   oauth-personal  Log in with Google                    (browser)
//   oauth-business  Log in with Gemini Enterprise         (browser)
//   gemini-api-key  Gemini API key                        (credential)
//   agent-platform  Gemini Enterprise Agent Platform      (ADC or API key)
//
// The bridge used to hardcode `oauth-personal`, which silently excluded
// enterprise, Vertex and API-key accounts. Reading the list fixes that and
// keeps working if Google adds or renames a method.
//
// The server validates the id (probed 2026-11): an unknown one answers
// -32602 "Unsupported auth method", so these ids are real routes and not
// decoration. A route being offered is not the same as it being usable: the
// credential methods need their own material, and the server says exactly what
// is missing ("GOOGLE_API_KEY, or ... GOOGLE_CLOUD_PROJECT ... must be set for
// Agent Platform authentication"). That message is surfaced verbatim rather
// than replaced by a generic retry hint.

export interface AgyAuthMethod {
	id: string;
	name: string;
	description?: string;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Parse `initialize.result.authMethods`. Malformed entries are skipped; an
 *  empty result means "the server said nothing", never an error. */
export function parseAuthMethods(result: unknown): AgyAuthMethod[] {
	if (!result || typeof result !== "object") return [];
	const raw = (result as Record<string, unknown>).authMethods;
	if (!Array.isArray(raw)) return [];
	const out: AgyAuthMethod[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const id = str(e.id);
		if (!id) continue;
		const method: AgyAuthMethod = { id, name: str(e.name) ?? id };
		const description = str(e.description);
		if (description) method.description = description;
		out.push(method);
	}
	return out;
}

/** Browser methods open a page and land on the loopback redirect; the rest
 *  authenticate from a credential already on the machine (an API key, ADC). */
export function isBrowserMethod(id: string): boolean {
	return id.startsWith("oauth-");
}

/** Choose the method to authenticate with. The requested id wins when the
 *  server offers it; otherwise the first browser method, then the first
 *  advertised one, and null when the server published none (the caller keeps
 *  its historical default). */
export function resolveAuthMethod(
	methods: readonly AgyAuthMethod[],
	requestedId?: string,
): AgyAuthMethod | null {
	if (methods.length === 0) return null;
	if (requestedId) {
		const exact = methods.find((m) => m.id === requestedId);
		if (exact) return exact;
	}
	return methods.find((m) => isBrowserMethod(m.id)) ?? methods[0] ?? null;
}

/** Menu label built from the server's own words, so the choice explains
 *  itself without this module inventing descriptions. */
export function authMethodLabel(method: AgyAuthMethod): string {
	return method.description ? `${method.name} - ${method.description}` : method.name;
}
