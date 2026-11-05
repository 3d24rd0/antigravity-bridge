// Single source of truth for the /agy command surface.
//
// Both the registered help text and Pi's argument completion read this table,
// so the documented usage can no longer drift from what the dispatcher accepts
// (the previous hand-written string still advertised `engine stream-json|acp`
// long after the command stopped switching engines).
//
// `values` is also what Tab completes for the first argument. Commands whose
// argument is free-form (a path, an alias, an id) carry no `values` and are
// completed by name only.

import type { AutocompleteItem } from "@earendil-works/pi-tui";

export interface AgySubcommand {
	/** Subcommand word typed after `/agy`. */
	name: string;
	/** One-line summary shown in completions and in the help text. */
	description: string;
	/** Exact usage fragment, including placeholders. */
	usage: string;
	/** Closed value set for the first argument, completed on Tab. */
	values?: readonly string[];
	/** Accepted but not advertised (deprecated or replaced). */
	hidden?: boolean;
}

export const AGY_SUBCOMMANDS: readonly AgySubcommand[] = [
	{ name: "doctor", description: "health check: driver state, versions, paths", usage: "doctor" },
	{ name: "auth", description: "prepare the ACP server and sign in", usage: "auth" },
	{ name: "auth-manual", description: "print the manual sign-in steps", usage: "auth-manual" },
	{ name: "engine", description: "engine is chosen by the model name (/model)", usage: "engine" },
	{ name: "acp-bin", description: "ACP server binary path", usage: "acp-bin <path|auto>", values: ["auto"] },
	{
		name: "mode",
		description: "execution mode (plan refuses provider turns)",
		usage: "mode accept-edits|plan",
		values: ["accept-edits", "plan"],
	},
	{ name: "readonly", description: "refuse provider turns", usage: "readonly on|off", values: ["on", "off"] },
	{
		name: "permissions",
		description: "native agy tool approvals",
		usage: "permissions on|off",
		values: ["on", "off"],
	},
	{ name: "ask", description: "AskAntigravity delegation tool", usage: "ask on|off", values: ["on", "off"] },
	{ name: "model", description: "AskAntigravity default model", usage: "model <alias>" },
	{
		name: "thinking",
		description: "AskAntigravity thinking level",
		usage: "thinking low|medium|high",
		values: ["low", "medium", "high"],
	},
	{ name: "agent", description: "custom agent for stream-json turns", usage: "agent <name|off>", values: ["off"] },
	{
		name: "bridge",
		description: "which Pi tools the bridge exposes",
		usage: "bridge all|mcp|none",
		values: ["all", "mcp", "none"],
	},
	{
		name: "tools",
		description: "hide or show individual Pi tools",
		usage: "tools [hide|show <name>|reset]",
		values: ["hide", "show", "reset"],
	},
	{ name: "web", description: "web tools for any provider", usage: "web on|off", values: ["on", "off"] },
	{
		name: "digest",
		description: "context digest on fresh conversations",
		usage: "digest on|off",
		values: ["on", "off"],
	},
	{
		name: "system-prompt",
		description: "carry Pi's system prompt",
		usage: "system-prompt on|off",
		values: ["on", "off"],
	},
	{ name: "timeout", description: "turn cap in minutes, or off", usage: "timeout <1-1440|off>", values: ["off"] },
	{ name: "quota", description: "remaining subscription quota", usage: "quota" },
	{ name: "tasks", description: "background task logs of this conversation", usage: "tasks [tail <id>]", values: ["tail"] },
	{
		name: "artifacts",
		description: "files produced or received by this conversation",
		usage: "artifacts [open <n|name>]",
		values: ["open"],
	},
	{ name: "subagents", description: "subagent roster of the live turn", usage: "subagents" },
	{
		name: "patch-cleanup",
		description: "restore a Pi carrying the old pi.invokeTool patch",
		usage: "patch-cleanup",
	},
	{ name: "clear", description: "drop stored conversation bindings", usage: "clear" },
	{ name: "status", description: "removed; use doctor", usage: "status", hidden: true },
];

/** Usage line for the registered help text, generated from the table. */
export function agyUsageLine(): string {
	return AGY_SUBCOMMANDS.filter((sub) => !sub.hidden)
		.map((sub) => sub.usage)
		.join(" | ");
}

/**
 * Tab completion for `/agy`.
 *
 * Pi passes the argument text after the command name; a leading `/agy` is also
 * accepted so either contract resolves. Completes subcommand names first, then
 * the closed value set of the selected subcommand.
 */
export function agyArgumentCompletions(argumentPrefix: string): AutocompleteItem[] {
	const text = (argumentPrefix ?? "").replace(/^\s*\/agy\s*/i, "");
	const words = text.trim().split(/\s+/);
	const head = (words[0] ?? "").toLowerCase();
	const endsWithSpace = /\s$/.test(text);
	if (words.length === 1 && !endsWithSpace) {
		return AGY_SUBCOMMANDS.filter((sub) => !sub.hidden && sub.name.startsWith(head)).map((sub) => ({
			value: sub.name,
			label: sub.name,
			description: sub.description,
		}));
	}
	const selected = AGY_SUBCOMMANDS.find((sub) => sub.name === head);
	if (!selected?.values) return [];
	const partial = endsWithSpace ? "" : (words[1] ?? "").toLowerCase();
	return selected.values
		.filter((value) => value.startsWith(partial))
		.map((value) => ({ value, label: value, description: selected.usage }));
}
