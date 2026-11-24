// Match only the known complete upstream notice, never general quota prose.
export function quotaNoticeError(text: string): string | undefined {
	if (text.length > 400) return undefined;
	const match = /^\s*(?:⚠\s*)?Individual\s+quota\s+reached\.\s+Please\s+upgrade\s+your\s+subscription\s+to\s+increase\s+your\s+limits\.(?:\s+Resets\s+in\s+((?:\d{1,4}h)?(?:\d{1,2}m)?(?:\d{1,2}s)?))?\s*$/i.exec(text);
	if (!match || (match[1] !== undefined && !match[1])) return undefined;
	return `agy rate limit (ResourceExhausted): Antigravity quota exhausted${match[1] ? `; resets in ${match[1]}` : ""}`;
}
