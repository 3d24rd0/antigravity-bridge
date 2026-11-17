// The plan comes from the ACP server's session result, under a vendor meta
// extension: `_meta.antigravity.tier`. Verified live against agy_acp_server
// 1.4.1, which answers {name:"Google AI Pro", id:"g1-pro-tier", upgradeUri}.
// Parsing must degrade to "unknown" for any other shape, never throw.

import assert from "node:assert/strict";
import { test } from "vitest";
import { parsePlanTier, planSummary } from "../src/acp/tier.js";

const sessionResult = (tier: unknown) => ({ sessionId: "s-1", _meta: { antigravity: { tier } } });

test("parsePlanTier: reads the real session/new shape", () => {
	assert.deepEqual(
		parsePlanTier(
			sessionResult({
				name: "Google AI Pro",
				id: "g1-pro-tier",
				upgradeUri: "https://antigravity.google/g1-upgrade",
			}),
		),
		{ name: "Google AI Pro", id: "g1-pro-tier", upgradeUri: "https://antigravity.google/g1-upgrade" },
	);
});

test("parsePlanTier: optional fields are omitted, not defaulted", () => {
	assert.deepEqual(parsePlanTier(sessionResult({ name: "Google AI Ultra" })), { name: "Google AI Ultra" });
	assert.deepEqual(parsePlanTier(sessionResult({ name: "  Enterprise  ", id: "" })), { name: "Enterprise" });
});

test("parsePlanTier: any other shape is null, never a throw", () => {
	for (const bad of [
		null,
		undefined,
		"s-1",
		{},
		{ sessionId: "s" },
		{ _meta: null },
		{ _meta: { antigravity: null } },
		{ _meta: { antigravity: { tier: true } } },
		sessionResult("pro"),
		sessionResult({ id: "g1-pro-tier" }),
		sessionResult({ name: "   " }),
	]) {
		assert.equal(parsePlanTier(bad), null, JSON.stringify(bad));
	}
});

test("planSummary: names the plan, and the upgrade link when the server offers one", () => {
	assert.equal(planSummary({ name: "Google AI Pro" }, "acp"), "Google AI Pro");
	assert.equal(
		planSummary({ name: "Google AI Pro", upgradeUri: "https://antigravity.google/g1-upgrade" }, "acp"),
		"Google AI Pro (upgrade: https://antigravity.google/g1-upgrade)",
	);
});

test("planSummary: says why it is unknown instead of pretending", () => {
	assert.match(planSummary(null, "acp"), /not reported yet/);
	assert.match(planSummary(undefined, "stream-json"), /only by the ACP engine/);
});
