// Stale-safe access to an extension's UI.
//
// pi invalidates an extension ctx after ctx.newSession(), ctx.fork(),
// ctx.switchSession() or ctx.reload(): from then on the `hasUI` getter and
// every `ui` call throw "This extension ctx is stale after session
// replacement or reload." (ExtensionRunner.assertActive). An extension that
// captures its ctx in `session_start` and touches it from an async callback
// therefore turns a routine reload into an uncaughtException that kills pi,
// because the fire-and-forget promise has nowhere to put the throw.
//
// Two rules keep that impossible:
//   1. Decide `hasUI` and grab `ui` ONCE, synchronously, before the first
//      await. The ctx is never read again.
//   2. Every later call goes through a wrapper that swallows the stale throw,
//      because `ui` itself dies with the ctx.
//
// Callers keep their own headless behaviour: `available === false` means "there
// was no UI", so a caller may still print to stderr. A live UI that went stale
// also reports false, and callers treat it the same way (the session is gone,
// nothing to toast).

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Notification levels pi's ui.notify accepts. */
export type UiNotifyLevel = "info" | "warning" | "error";

/** The slice of a UI context this module needs. */
export type UiLike = Pick<ExtensionUIContext, "notify" | "setStatus">;

/** The slice of a session/command ctx this module needs. */
export interface CtxLike {
	readonly hasUI: boolean;
	readonly ui: UiLike;
}

export interface UiSink {
	/** True when a UI existed at capture time. */
	readonly available: boolean;
	/** Notify the captured UI. Returns true when the message was handed over. */
	notify(message: string, level?: UiNotifyLevel): boolean;
	/** Update a status row. Returns true when the call was handed over. */
	setStatus(key: string, text: string | undefined): boolean;
}

/** Notify through `ui`, surviving a stale ctx. */
export function notifySafely(
	ui: UiLike | null | undefined,
	message: string,
	level: UiNotifyLevel = "info",
): boolean {
	if (!ui) return false;
	try {
		ui.notify(message, level);
		return true;
	} catch {
		// Session replaced or reloaded: the UI this ctx pointed at is gone.
		return false;
	}
}

/** Set (or clear) a status row, surviving a stale ctx. */
export function setStatusSafely(
	ui: UiLike | null | undefined,
	key: string,
	text: string | undefined,
): boolean {
	if (!ui) return false;
	try {
		ui.setStatus(key, text);
		return true;
	} catch {
		return false;
	}
}

/** Capture a ctx's UI once, synchronously, into a sink that never throws.
 *  Call this at the top of an event or command handler, before any await. */
export function captureUiSink(ctx: CtxLike): UiSink {
	let available = false;
	let ui: UiLike | undefined;
	try {
		available = ctx.hasUI;
		if (available) ui = ctx.ui;
	} catch {
		// Already stale: treat exactly like a headless session.
		available = false;
		ui = undefined;
	}
	return {
		available,
		notify: (message, level) => notifySafely(ui, message, level),
		setStatus: (key, text) => setStatusSafely(ui, key, text),
	};
}
