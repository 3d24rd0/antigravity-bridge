// The signed-in plan, as Google's ACP server reports it.
//
// Verified live against agy_acp_server (1.4.1, 2026-11): `initialize` only
// advertises the capability (agentCapabilities._meta.antigravity.tier === true)
// and `session/new` carries the answer:
//
//   "_meta": { "antigravity": { "tier": {
//       "name": "Google AI Pro",
//       "id": "g1-pro-tier",
//       "upgradeUri": "https://antigravity.google/g1-upgrade"
//   } } }
//
// No local file holds it (google_accounts.json is just the active email), and
// the CLI engine never reports it, so this is the only honest source. Parsing
// is defensive: the field arrives nested under a vendor meta extension, and a
// shape change must degrade to "unknown" instead of throwing mid-turn.

export interface AgyPlanTier {
	/** Display name, e.g. "Google AI Pro". */
	name: string;
	/** Server-side tier id, e.g. "g1-pro-tier". */
	id?: string;
	/** Where to upgrade, when the server offers one. */
	upgradeUri?: string;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Read the plan out of a session/new or session/load result. Null when the
 *  server did not report one. */
export function parsePlanTier(result: unknown): AgyPlanTier | null {
	if (!result || typeof result !== "object") return null;
	const meta = (result as Record<string, unknown>)._meta;
	if (!meta || typeof meta !== "object") return null;
	const vendor = (meta as Record<string, unknown>).antigravity;
	if (!vendor || typeof vendor !== "object") return null;
	const tier = (vendor as Record<string, unknown>).tier;
	if (!tier || typeof tier !== "object") return null;
	const t = tier as Record<string, unknown>;
	const name = str(t.name);
	if (!name) return null;
	const out: AgyPlanTier = { name };
	const id = str(t.id);
	const upgradeUri = str(t.upgradeUri);
	if (id) out.id = id;
	if (upgradeUri) out.upgradeUri = upgradeUri;
	return out;
}

/** Doctor/quota value: the plan name, or why there is none. */
export function planSummary(tier: AgyPlanTier | null | undefined, engine: "acp" | "stream-json"): string {
	if (engine !== "acp") return "reported only by the ACP engine";
	if (!tier) return "not reported yet (the ACP server answers on the first session)";
	return tier.upgradeUri ? `${tier.name} (upgrade: ${tier.upgradeUri})` : tier.name;
}
