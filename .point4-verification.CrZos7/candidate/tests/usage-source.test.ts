// Unit tests for Gentle Shell usage source integration (src/usage-source.ts).
//
// Verifies the gentle-pi:usage-source/v1 event payload, conversion from
// AgyQuotaReport + ACP plan tier to ProviderUsage, fail-closed handling when
// the CLI is absent or quota fetch fails, and session_start registration.
// Run: npx vitest run tests/usage-source.test.ts

import assert from "node:assert/strict";
import { test } from "vitest";
import { parseAgyUsageJson, type AgyQuotaReport } from "../src/usage.js";
import {
	ANTIGRAVITY_PROVIDER_ID,
	GENTLE_USAGE_SOURCE_EVENT,
	GENTLE_USAGE_SOURCE_SCHEMA,
	createAntigravityUsageSource,
	registerAntigravityUsageSource,
	toGentleProviderUsage,
} from "../src/usage-source.js";

const REAL_PAYLOAD = JSON.stringify({
	conversation_id: "",
	status: "SUCCESS",
	duration_seconds: 0,
	num_turns: 0,
	usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	command: {
		name: "usage",
		data: {
			groups: [
				{
					name: "Gemini Models",
					buckets: [
						{
							id: "gemini-weekly",
							name: "Weekly Limit Remaining",
							window: "weekly",
							remaining_fraction: 0.8991343975067139,
							reset_time: "2026-09-30T23:20:40Z",
						},
						{
							id: "gemini-5h",
							name: "Five Hour Limit Remaining",
							window: "5h",
							remaining_fraction: 1,
							reset_time: "2026-09-25T01:36:24Z",
						},
					],
				},
				{
					name: "Claude and GPT models",
					buckets: [
						{
							id: "3p-weekly",
							name: "Weekly Limit Remaining",
							window: "weekly",
							remaining_fraction: 0.75,
							reset_time: "2026-10-01T20:36:24Z",
						},
						{
							id: "3p-5h",
							name: "Five Hour Limit Remaining",
							window: "5h",
							remaining_fraction: 0.5,
							reset_time: "2026-09-25T01:36:24Z",
						},
					],
				},
			],
		},
	},
});

test("toGentleProviderUsage: maps groups, inverts fractions, orders 5h before week, and attaches plan", () => {
	const report = parseAgyUsageJson(REAL_PAYLOAD);
	const fetchedAt = 1_790_000_000_000;
	const usage = toGentleProviderUsage(report, fetchedAt, "Google AI Pro");

	assert.ok(usage);
	assert.equal(usage.provider, ANTIGRAVITY_PROVIDER_ID);
	assert.equal(usage.plan, "Google AI Pro");
	assert.equal(usage.fetchedAt, fetchedAt);
	assert.equal(usage.limits.length, 2);

	const [gemini, thirdParty] = usage.limits;
	assert.equal(gemini.name, "Gemini Models");
	assert.equal(gemini.limitReached, false);
	assert.equal("scope" in gemini, false);
	assert.deepEqual(
		gemini.windows.map((w) => w.label),
		["5h", "week"],
	);
	assert.deepEqual(gemini.windows[0], {
		label: "5h",
		usedPercent: 0,
		windowSeconds: 18_000,
		resetAt: Date.parse("2026-09-25T01:36:24Z"),
	});
	assert.equal(gemini.windows[1].label, "week");
	assert.equal(gemini.windows[1].windowSeconds, 604_800);
	assert.ok(Math.abs(gemini.windows[1].usedPercent - (1 - 0.8991343975067139) * 100) < 1e-9);
	assert.equal(gemini.windows[1].resetAt, Date.parse("2026-09-30T23:20:40Z"));

	assert.equal(thirdParty.name, "Claude and GPT models");
	assert.equal(thirdParty.limitReached, false);
	assert.deepEqual(
		thirdParty.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent })),
		[
			{ label: "5h", usedPercent: 50 },
			{ label: "week", usedPercent: 25 },
		],
	);
});

test("toGentleProviderUsage: omits blank plan and marks disabled or zero-remaining groups as limitReached", () => {
	const report: AgyQuotaReport = {
		groups: [
			{
				name: "Gemini Models",
				buckets: [{ name: "5h", window: "5h", remainingFraction: 0.4, resetTime: "not-a-date" }],
			},
			{
				name: "Claude and GPT models",
				buckets: [
					{ name: "5h", window: "5h", remainingFraction: 0.2, disabled: true, resetTime: "2026-10-01T00:00:00Z" },
					{ name: "weekly", window: "weekly", remainingFraction: 0 },
				],
			},
			{
				name: "Empty Group",
				buckets: [],
			},
		],
	};

	const usage = toGentleProviderUsage(report, 123_456, "   ");
	assert.ok(usage);
	assert.equal(usage.plan, undefined);
	assert.equal(usage.limits.length, 2);
	assert.equal(usage.limits[0].limitReached, false);
	assert.equal(usage.limits[0].windows[0].resetAt, null);

	assert.equal(usage.limits[1].limitReached, true);
	assert.equal(usage.limits[1].windows[0].usedPercent, 100);
	assert.equal(usage.limits[1].windows[1].usedPercent, 100);
	assert.equal(usage.limits[1].windows[1].resetAt, null);
});

test("toGentleProviderUsage: handles generic window durations and returns undefined when no limits have windows", () => {
	const empty: AgyQuotaReport = { groups: [{ name: "Empty", buckets: [] }] };
	assert.equal(toGentleProviderUsage(empty, 1_000), undefined);

	const custom: AgyQuotaReport = {
		groups: [
			{
				name: "Custom",
				buckets: [
					{ name: "30m", window: "30m", remainingFraction: 0.5 },
					{ name: "2d", window: "2d", remainingFraction: 0.75 },
					{ name: "mystery", window: "custom", remainingFraction: 1 },
				],
			},
		],
	};
	const usage = toGentleProviderUsage(custom, 2_000);
	assert.ok(usage);
	assert.deepEqual(
		usage.limits[0].windows.map((w) => ({ label: w.label, windowSeconds: w.windowSeconds })),
		[
			{ label: "30m", windowSeconds: 1800 },
			{ label: "2d", windowSeconds: 172_800 },
			{ label: "custom", windowSeconds: 0 },
		],
	);
});

test("createAntigravityUsageSource: returns undefined without spawning when agy CLI is missing", async () => {
	let fetched = false;
	const source = createAntigravityUsageSource({
		getBinary: () => "agy",
		isInstalled: () => false,
		fetchReport: async () => {
			fetched = true;
			return undefined;
		},
	});

	assert.equal(source.schema, GENTLE_USAGE_SOURCE_SCHEMA);
	assert.equal(source.provider, ANTIGRAVITY_PROVIDER_ID);
	const out = await source.fetch(undefined, globalThis.fetch, 5_000);
	assert.equal(out, undefined);
	assert.equal(fetched, false);
});

test("createAntigravityUsageSource: reads latest plan name after fetch completes and degrades cleanly on empty fetch", async () => {
	const report = parseAgyUsageJson(REAL_PAYLOAD);
	let plan: string | undefined;
	const source = createAntigravityUsageSource({
		getBinary: () => "/usr/local/bin/agy",
		isInstalled: () => true,
		getPlanName: () => plan,
		fetchReport: async (_bin, now) => {
			plan = "Google AI Ultra";
			return { report, fetchedAt: now };
		},
	});

	const ok = await source.fetch("not-used", globalThis.fetch, 9_999);
	assert.ok(ok);
	assert.equal(ok.plan, "Google AI Ultra");
	assert.equal(ok.fetchedAt, 9_999);

	const failingSource = createAntigravityUsageSource({
		getBinary: () => "/usr/local/bin/agy",
		isInstalled: () => true,
		fetchReport: async () => undefined,
	});
	assert.equal(await failingSource.fetch(undefined, globalThis.fetch, 10_000), undefined);
});

test("registerAntigravityUsageSource: emits gentle-pi:usage-source/v1 on session_start", () => {
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const listeners = new Map<string, Array<() => void>>();

	const fakePi = {
		on(event: string, handler: () => void) {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
		},
		events: {
			emit(event: string, payload: unknown) {
				emitted.push({ event, payload });
			},
		},
	};

	const source = registerAntigravityUsageSource(fakePi, {
		getBinary: () => "agy",
		isInstalled: () => true,
	});

	assert.equal(emitted.length, 0);
	for (const handler of listeners.get("session_start") ?? []) handler();
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].event, GENTLE_USAGE_SOURCE_EVENT);
	assert.equal(emitted[0].payload, source);
});
