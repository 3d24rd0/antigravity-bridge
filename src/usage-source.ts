// Gentle Shell usage-source adapter (`gentle-pi:usage-source/v1`).
//
// Translates Antigravity's `agy --print /usage --output-format json` report
// (and ACP `session/new` plan tier when available) into Gentle Shell's
// `ProviderUsage` contract. Emitting on `pi.events` is a zero-cost no-op in
// vanilla Pi and integrates natively with Gentle Shell's `/gentle:usage`
// panel, status bar, and Desktop RPC without any runtime dependency on
// `gentle-pi`.

import { isAgyInstalled } from "./engine-picker.js";
import { getOrFetchAgyQuota, QUOTA_WINDOW_RANK, type AgyQuotaBucket, type AgyQuotaReport } from "./usage.js";

export const GENTLE_USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const GENTLE_USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";
export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;
const MINUTE_SECONDS = 60;
const FIVE_HOUR_SECONDS = 5 * HOUR_SECONDS;
const WEEK_SECONDS = 7 * DAY_SECONDS;

export interface GentleUsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

export interface GentleUsageLimit {
	name: string;
	windows: GentleUsageWindow[];
	limitReached: boolean;
}

export interface GentleProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: GentleUsageLimit[];
	fetchedAt: number;
}

export interface GentleUsageSource {
	schema: typeof GENTLE_USAGE_SOURCE_SCHEMA;
	provider: string;
	pendingNote?: string;
	fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<GentleProviderUsage | undefined>;
}

export interface AntigravityUsageSourceDeps {
	getBinary: () => string;
	getPlanName?: () => string | undefined;
	isInstalled?: (binary: string) => boolean;
	fetchReport?: (binary: string, now: number) => Promise<{ report: AgyQuotaReport; fetchedAt: number } | undefined>;
}

export interface UsageSourcePiHost {
	on(event: "session_start", handler: () => void): void;
	events: {
		emit(channel: string, data: unknown): void;
	};
}

function windowMeta(rawWindow: string): { label: string; windowSeconds: number } {
	const normalized = rawWindow.trim().toLowerCase();
	if (normalized === "5h") return { label: "5h", windowSeconds: FIVE_HOUR_SECONDS };
	if (normalized === "weekly") return { label: "week", windowSeconds: WEEK_SECONDS };

	const hoursMatch = /^(\d+)h$/.exec(normalized);
	if (hoursMatch) return { label: normalized, windowSeconds: Number(hoursMatch[1]) * HOUR_SECONDS };

	const daysMatch = /^(\d+)d$/.exec(normalized);
	if (daysMatch) return { label: normalized, windowSeconds: Number(daysMatch[1]) * DAY_SECONDS };

	const minutesMatch = /^(\d+)m$/.exec(normalized);
	if (minutesMatch) return { label: normalized, windowSeconds: Number(minutesMatch[1]) * MINUTE_SECONDS };

	return { label: rawWindow.trim() || "unknown", windowSeconds: 0 };
}

function toGentleWindow(bucket: AgyQuotaBucket): GentleUsageWindow {
	const { label, windowSeconds } = windowMeta(bucket.window);
	const remaining = Math.max(0, Math.min(1, bucket.remainingFraction));
	const usedPercent = bucket.disabled ? 100 : (1 - remaining) * 100;
	const parsedReset = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
	return {
		label,
		usedPercent,
		windowSeconds,
		resetAt: Number.isFinite(parsedReset) ? parsedReset : null,
	};
}

/** Convert an `AgyQuotaReport` into Gentle Shell's `ProviderUsage` shape.
 *  Returns `undefined` when no group carries any window. */
export function toGentleProviderUsage(
	report: AgyQuotaReport,
	fetchedAt: number,
	plan?: string,
): GentleProviderUsage | undefined {
	const limits: GentleUsageLimit[] = [];
	for (const group of report.groups) {
		const sortedBuckets = [...group.buckets].sort(
			(a, b) => (QUOTA_WINDOW_RANK[a.window] ?? 9) - (QUOTA_WINDOW_RANK[b.window] ?? 9),
		);
		const windows = sortedBuckets.map(toGentleWindow);
		if (windows.length === 0) continue;
		const limitReached = sortedBuckets.some((b) => b.disabled === true || b.remainingFraction <= 0);
		limits.push({
			name: group.name,
			windows,
			limitReached,
		});
	}
	if (limits.length === 0) return undefined;
	const trimmedPlan = plan?.trim();
	return {
		provider: ANTIGRAVITY_PROVIDER_ID,
		plan: trimmedPlan || undefined,
		limits,
		fetchedAt,
	};
}

/** Build the `gentle-pi.usage-source/v1` descriptor for `antigravity`. */
export function createAntigravityUsageSource(deps: AntigravityUsageSourceDeps): GentleUsageSource {
	const checkInstalled = deps.isInstalled ?? ((bin: string) => isAgyInstalled(bin));
	const loadReport =
		deps.fetchReport ??
		((bin: string, now: number) => getOrFetchAgyQuota(bin, { now }));

	return {
		schema: GENTLE_USAGE_SOURCE_SCHEMA,
		provider: ANTIGRAVITY_PROVIDER_ID,
		fetch: async (_apiKey, _fetchFn, now) => {
			const binary = deps.getBinary();
			if (!checkInstalled(binary)) return undefined;
			const entry = await loadReport(binary, now);
			if (!entry) return undefined;
			return toGentleProviderUsage(entry.report, entry.fetchedAt, deps.getPlanName?.());
		},
	};
}

/** Register the Antigravity usage source on `session_start` so load order
 *  between extensions cannot drop the registration. */
export function registerAntigravityUsageSource(
	pi: UsageSourcePiHost,
	deps: AntigravityUsageSourceDeps,
): GentleUsageSource {
	const source = createAntigravityUsageSource(deps);
	pi.on("session_start", () => {
		pi.events.emit(GENTLE_USAGE_SOURCE_EVENT, source);
	});
	return source;
}
