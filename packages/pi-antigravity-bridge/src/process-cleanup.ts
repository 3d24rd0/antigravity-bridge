// Host-aware process cleanup registration.
//
// The bridge must tear down its child process groups when pi dies, but it must
// NOT own pi's signal handling: the host (or another extension) may need to run
// its own shutdown first. Rules enforced here:
//
//   - the synchronous 'exit' cleanup is always registered (no conflict: every
//     listener runs, and it cannot block or reorder termination);
//   - a signal handler is installed ONLY when the host has no listener for that
//     signal, so Ctrl+C / SIGTERM keep the host's semantics;
//   - reloading the extension in the same process replaces this key's previous
//     handlers instead of stacking another set (the old closures would point at
//     ledgers no new child ever writes to).
//
// Run: npm test

type Signal = NodeJS.Signals | "exit";
type Handler = () => void;

export interface CleanupOptions {
	/** Always-registered synchronous cleanup (process 'exit'). */
	exit: Handler;
	/** Per-signal cleanup, installed only when the host has no listener. */
	signals?: Partial<Record<NodeJS.Signals, Handler>>;
	/** Injectable ownership probe (tests). Default: a foreign listener exists. */
	hasHostListener?: (sig: NodeJS.Signals) => boolean;
}

const REGISTRY_KEY: unique symbol = Symbol.for("pi-me.process-cleanup");

function registry(): Map<string, Array<[Signal, Handler]>> {
	const host = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = host[REGISTRY_KEY] as Map<string, Array<[Signal, Handler]>> | undefined;
	if (existing) return existing;
	const created = new Map<string, Array<[Signal, Handler]>>();
	host[REGISTRY_KEY] = created;
	return created;
}

/** True when anything else already listens for `sig`. */
export function hostOwnsSignal(sig: NodeJS.Signals): boolean {
	return process.listenerCount(sig) > 0;
}

/** Register `key`'s cleanup, replacing whatever that key registered before. */
export function installProcessCleanup(key: string, opts: CleanupOptions): void {
	const reg = registry();
	const previous = reg.get(key) ?? [];
	// Drop our own previous handlers FIRST: the ownership probe below must see
	// only foreign listeners, or a reload would read its own stale handler as
	// host ownership and never reinstall.
	for (const [sig, handler] of previous) process.off(sig, handler);
	const hasHost = opts.hasHostListener ?? hostOwnsSignal;
	const installed: Array<[Signal, Handler]> = [];
	process.on("exit", opts.exit);
	installed.push(["exit", opts.exit]);
	for (const [sig, handler] of Object.entries(opts.signals ?? {})) {
		const signal = sig as NodeJS.Signals;
		if (hasHost(signal)) continue;
		process.on(signal, handler);
		installed.push([signal, handler]);
	}
	reg.set(key, installed);
}

/** Conventional exit code for a termination signal. */
export function signalExitCode(sig: NodeJS.Signals): number {
	return sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129;
}
