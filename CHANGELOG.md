# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-11-03

### Added

- **`/agy` completes with Tab.** Pi autocompletes registered command names only, so everything after `/agy ` was undiscoverable from the editor: `RegisteredCommand` has carried `getArgumentCompletions` all along and the command never used it. Subcommand names complete first (`/agy do` → `doctor`), then the closed value set of the selected one (`/agy mode ` → `accept-edits`, `plan`). Free-form arguments (paths, aliases, ids) complete nothing rather than guessing.

### Changed

- **The entry point lives in `src/entry.ts`.** Pi's `extensions/` directory is a convention for packages that rely on automatic discovery, but this package already declares `pi.extensions` explicitly, so the folder duplicated the manifest with a single 50 kB file. The explicit path is the documented form for resources that live elsewhere, and the published `files` list now drops `extensions` and ships `src/` with the rest.
- **The repository is a single package at its root, renamed `antigravity-bridge`.** The monorepo layout was a leftover from when it carried four packages; what remained was one workspace under a private root manifest whose only job was pointing at the subfolder. Nothing about npm distribution changes (the tarball was already flat and pi.dev indexes packages by the `pi-package` keyword), but **git installs move to `pi install git:github.com/3d24rd0/antigravity-bridge`** — GitHub redirects the old URL.
- **The project presents as *Antigravity Bridge*.** Title, npm description and gallery card drop the package-style name. The package itself stays `@3d24rd0/pi-antigravity-bridge`: pi.dev indexes npm packages by the `pi-package` keyword rather than by their name, and an unscoped `antigravity-bridge` is already taken, so a rename would break installs and buy no discoverability.
- **The `/agy` help text and its completion come from one table** (`src/agy-command-surface.ts`), so the documented usage can no longer drift from the dispatcher. The hand-written description still advertised `engine stream-json|acp` long after `/agy engine` stopped switching engines; the retired `status` entry stays accepted but is no longer listed.
- Dependencies refreshed: vitest 5.1.0, `@earendil-works/*` 1.5.0, `@modelcontextprotocol/sdk` 1.32.2, TypeScript 7.0.2, `@types/node` 26.6.6. Three unused dev dependencies were dropped, and `npm audit` reports no vulnerabilities.

### Fixed

- **The MCP handshake reports the real version.** `serverInfo.version` was hardcoded to `1.0.0`, so this release would have introduced itself to every MCP client as the previous one. It is now read from `package.json` at load, with a clearly-invalid placeholder (`0.0.0-unknown`) if the manifest is unreadable, and the tests pin the wiring rather than the current number.

## [1.0.0] - 2026-11-02

Fork of
[`@estebanforge/pi-antigravity-bridge`](https://www.npmjs.com/package/@estebanforge/pi-antigravity-bridge)
**1.8.7** by [@EstebanForge](https://github.com/EstebanForge). Everything below
changed on top of that baseline; this is the first public release under
`@3d24rd0`.

### Changed

- **The settings and engine dialogs run on Pi's own TUI kit.** `SettingsList` and `SelectList` from `@earendil-works/pi-tui` replace `@estebanforge/pi-tui-dialogs`, which is no longer a dependency. The `/agy` menu keeps its rows, two-column values, type-to-search and stage-then-save-on-close; the engine picker keeps its intro paragraph and esc-means-decide-later. A dead "Switch engine" row was removed: its Enter resolved the menu with an id nothing consumed.
- **The row id -> config mapping is a pure function (`applySettingChange`)** so the settings surface is covered by tests without a TUI.
- **Improve `/agy quota` display fidelity.** Renders model group subtitles (e.g. models included in each group) and handles `disabled: true` quota buckets (e.g. 5-hour limit when weekly limit is reached) with clear explanatory notices instead of rendering a misleading 100% bar.
- **Safety clamp on large bridge tool outputs (`clampToolOutput`, 32KB max).** Bridge tool call outputs exceeding 32,000 characters are now safely truncated at the boundary with an informative notice advising line-range or command filters. This serves as an unbreachable fuse preventing runaway command or file reads from permanently poisoning conversation context windows and exhausting rolling 3-hour quotas.
- **Token conservation guidance in tool-priority note.** Instructs models to proactively bound tool calls with `StartLine`/`EndLine` for files over ~100 lines and use `head`, `tail`, or `--stat` for terminal commands.
- **Filter out orchestrator and administrative tools from the bridge catalog.** Tools intended solely for internal orchestrator relays (`orchestrator_*`, `gentle_odd_phase`, `session_worktree_register`) and administrative memory tools (`mem_doctor`, `mem_judge`, `mem_compare`, `mem_stats`, etc.) are excluded from the MCP tool catalog, while keeping `gentle_review` and essential tools active for primary orchestrator workflows.
- **Set default thinking tier to `low` in defaults.** New configurations and default fallback now default to `low` thinking effort to prevent unnecessary reasoning token consumption on high-volume models like Gemini Flash.
- **Condense `activate_skill` tool catalog description.** `activate_skill` description now provides a concise comma-separated list of available skill names instead of full multi-line descriptions that duplicated the system prompt.

### Fixed

- **A turn that stalls after streaming text now delivers the answer recovered from the transcript.** The missing tail is emitted when the recovered answer extends what was streamed; a divergent answer is added as its own block instead of being dropped or duplicated. Previously only turns that had streamed nothing received the recovery.
- **A stranded escalated tool result stays on the current conversation.** It no longer moves the next turn to the conversation that produced it, and no longer deletes the binding of the conversation the user is on. The current binding wins; the strand's conversation is a fallback only when the session has none.
- **The silent-over-cap and poisoned-conversation guards also classify the late redelivery turn**, so an over-cap redelivery fails visibly instead of persisting an empty `OK`.
- **`SessionStore` no longer loses a mutation that lands mid-write.** Each write clears only the keys it captured, so a concurrent `set()`/`delete()` survives to disk.
- **Permission dialogs resolve the picked option by identity.** Duplicate labels are disambiguated, so the answered `optionId` is the one the user chose; an expired park closes the dialog instead of leaving a zombie holding the cross-extension dialog lock.
- **Signal cleanup never overrides the host.** Handlers install only when Pi owns nothing for that signal, ownership is re-checked when the signal arrives, sibling bridge keys are not mistaken for the host, and a reload replaces this key's handlers instead of stacking.
- **The deferred hard kill keeps the process group in the emergency ledger** until the child exits, and its timer no longer holds the event loop open.
- **Settled approval tickets are reaped on every decision**, not only when the next approval is parked.
- **`isAgyInstalled` works on Windows**: backslash paths are treated as paths and a bare name is resolved through `PATHEXT` (including dotted names such as `agy.v2`).
- **`@earendil-works/pi-ai` is declared** as a peer dependency (it was imported by seven modules and resolved only through hoisting).

---

History up to 1.8.7 belongs to the upstream project:
[EstebanForge/pi-extensions](https://github.com/EstebanForge/pi-extensions).
