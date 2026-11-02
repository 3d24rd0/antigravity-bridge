// Dialog option labels for the ACP permission gate.
//
// ACP servers may offer several options with the same display name (for
// example allow_once and allow_always both named "Allow"). The dialog returns
// the picked LABEL, so a duplicate makes the mapping ambiguous and the first
// match wins — the wrong option is selected. Suffixing repeats keeps every
// label unique without changing the single-occurrence case.

/** Disambiguate repeated labels: ["Allow", "Allow"] -> ["Allow", "Allow (2)"]. */
export function distinctLabels(base: string[]): string[] {
	const seen = new Map<string, number>();
	return base.map((label) => {
		const count = (seen.get(label) ?? 0) + 1;
		seen.set(label, count);
		return count === 1 ? label : `${label} (${count})`;
	});
}
