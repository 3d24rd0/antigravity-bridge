// Antigravity's backend injects async background-task notifications wrapped in
// <SYSTEM_MESSAGE> blocks, and Gemini (3.8 Flash especially) echoes them back
// verbatim as assistant text. They are not part of the answer.
//
// The sanitizer has to be stateful: a delta boundary can land anywhere inside
// the block, so the text cannot be filtered after the fact without leaking
// fragments. It fails open - a block that never closes is emitted at EOF (or
// once it grows past the cap), because losing real text is worse than showing
// an echo.

const OPEN = "<SYSTEM_MESSAGE>";
const CLOSE = "</SYSTEM_MESSAGE>";

/** How much block text to retain while waiting for CLOSE before giving up. */
const DEFAULT_MAX_HELD = 64 * 1024;

/** Length of the longest suffix of `text` that is a proper prefix of `marker`. */
function heldTail(text: string, marker: string): number {
	const max = Math.min(text.length, marker.length - 1);
	for (let k = max; k > 0; k--) {
		if (text.endsWith(marker.slice(0, k))) return k;
	}
	return 0;
}

export class SystemMessageSanitizer {
	#buf = "";
	#held = "";
	#dropping = false;
	readonly #maxHeld: number;

	constructor(opts: { maxHeld?: number } = {}) {
		this.#maxHeld = opts.maxHeld ?? DEFAULT_MAX_HELD;
	}

	/** Feed one streamed delta; returns the text that is safe to show. */
	push(delta: string): string {
		this.#buf += delta;
		let out = "";
		for (;;) {
			if (this.#dropping) {
				const end = this.#buf.indexOf(CLOSE);
				if (end === -1) {
					// Retain the block in case it never closes; keep only a tail
					// that could still become CLOSE.
					const keep = Math.min(this.#buf.length, CLOSE.length - 1);
					this.#held += this.#buf.slice(0, this.#buf.length - keep);
					this.#buf = this.#buf.slice(this.#buf.length - keep);
					if (this.#held.length > this.#maxHeld) return out + this.#release();
					return out;
				}
				this.#held = "";
				this.#dropping = false;
				this.#buf = this.#buf.slice(end + CLOSE.length);
				continue;
			}
			const open = this.#buf.indexOf(OPEN);
			if (open !== -1) {
				out += this.#buf.slice(0, open);
				this.#buf = this.#buf.slice(open + OPEN.length);
				this.#dropping = true;
				continue;
			}
			const hold = heldTail(this.#buf, OPEN);
			out += this.#buf.slice(0, this.#buf.length - hold);
			this.#buf = this.#buf.slice(this.#buf.length - hold);
			return out;
		}
	}

	/** Emit whatever is still buffered (fail open) and reset. */
	flush(): string {
		const out = this.#dropping ? this.#release() : this.#buf;
		this.#buf = "";
		this.#held = "";
		this.#dropping = false;
		return out;
	}

	/** Reconstruct a block we gave up on: the OPEN marker plus what followed it. */
	#release(): string {
		const out = OPEN + this.#held + this.#buf;
		this.#buf = "";
		this.#held = "";
		this.#dropping = false;
		return out;
	}
}
