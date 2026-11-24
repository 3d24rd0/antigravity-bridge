// Dialog option labels for the ACP permission gate.
//
// ACP servers may offer several options with the same display name (for
// example allow_once and allow_always both named "Allow"). The dialog returns
// the picked LABEL, so a duplicate makes the mapping ambiguous and the first
// match wins — the wrong option is selected. Suffixing repeats keeps every
// label unique without changing the single-occurrence case.
//
// A server label may itself already look like a generated suffix (for example
// "Allow (2)"). Reserving every original label first means a generated suffix
// always skips text a later position needs verbatim, so uniqueness holds for
// any input while labels that stay free keep their exact bytes.

/** Disambiguate repeated labels: ["Allow", "Allow"] -> ["Allow", "Allow (2)"]. */
export function distinctLabels(base: string[]): string[] {
	const reserved = new Set(base);
	const used = new Set<string>();
	return base.map((label) => {
		let candidate = label;
		if (used.has(candidate)) {
			let n = 2;
			while (reserved.has(`${label} (${n})`) || used.has(`${label} (${n})`)) n += 1;
			candidate = `${label} (${n})`;
		}
		used.add(candidate);
		return candidate;
	});
}
