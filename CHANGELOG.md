# Changelog

## [1.2.0]

### Added

- Images reach the model on the stream-json engine too: the prompt is text-only, so the pixels are staged as per-turn 0600 files and the model is pointed at them. Both `-cli` variants advertise text+image.

### Fixed

- Echoed `<SYSTEM_MESSAGE>` blocks are stripped from both engines, even when the delta boundary lands inside the marker. Unterminated blocks fail open.
- A late delivery carries the images the parked call produced; text alone left the model hunting OCR tools.
- A conversation is bound as soon as a turn parks, so a first turn that parks and then dies still has a record to resume from.
- Parked time no longer consumes the overall turn cap: it freezes at the first park and resumes with the remaining budget.

## [1.1.1]

### Fixed

- The AskAntigravity expand hint comes from the render context, so Pi 1.5 no longer hides the key; on Pi 1.4, or outside an interactive theme, it degrades to the plain description instead of throwing.
- Refusals and validation errors render with the error glyph instead of a success checkmark.
- An empty turn logs at error level, so the error-only daily log records the stall.

### Changed

- Both engines get `queuedMessages: "send-immediately"` in their own settings.json when the key is absent, so input typed mid-turn is not buffered until the turn ends. Additive, atomic, an explicit user value wins, and an unparseable file is never touched.

## [1.1.0]

### Added

- Tab completion for `/agy`: subcommand names, then the values of the selected one.
- A logo, declared as `pi.image` so the gallery shows a preview.

### Changed

- The `/agy` help text and its completion come from one table, so the advertised usage cannot drift from the dispatcher.
- The entry point is `src/entry.ts`, declared in `pi.extensions`; the single-file `extensions/` directory is gone.
- One package at the repository root, renamed `antigravity-bridge`: git installs move to `git:github.com/3d24rd0/antigravity-bridge`, and GitHub redirects the old URL.
- The project presents as *Antigravity Bridge*; the npm name is unchanged.
- Docs split into a README front page plus `docs/how-it-works.md`.
- Dependencies refreshed (vitest 5.1.0, `@earendil-works/*` 1.5.0, `@modelcontextprotocol/sdk` 1.32.2, TypeScript 7.0.2, `@types/node` 26.6.6); unused dev dependencies dropped, `npm audit` clean.

### Fixed

- The MCP handshake reports the real version; it was hardcoded to `1.0.0`.

## [1.0.0]

Fork of [`@estebanforge/pi-antigravity-bridge`](https://www.npmjs.com/package/@estebanforge/pi-antigravity-bridge) 1.8.7 by [@EstebanForge](https://github.com/EstebanForge). Everything below changed on top of that baseline.

### Added

- Explicit `-acp` and `-cli` model variants, so the engine is chosen in `/model` instead of a global toggle.
- The full `agy models` catalog; the previous artificial filtering is gone.

### Changed

- `/agy quota` renders model groups and handles disabled buckets instead of a misleading 100% bar.
- Claude models route to stream-json even when ACP is the active engine; the ACP server rejects non-Gemini ids.
- All runtime data lives under `~/.pi/agent/antigravity-bridge`.
- Three sibling packages are inlined here; nothing else has to be installed.
- Settings and engine dialogs moved to Pi's `pi-tui` (`SettingsList`, `SelectList`); `@estebanforge/pi-tui-dialogs` is no longer a dependency.
- The row id to config mapping is a pure function, tested without a TUI.
- The MCP server declares `tools.listChanged`, and provider responses are forwarded through `onResponse`.
- Bridge tool output is clamped at 32,000 characters, and the tool-priority note asks models to bound reads and terminal output.
- Orchestrator internals and administrative memory tools are excluded from the catalog; `gentle_review`, `mem_judge`, `mem_review` and `mem_compare` stay available.
- Default thinking tier is `low`, and the `activate_skill` description lists skill names only.
- Host-provided peers (`@earendil-works/*`, `typebox`) are declared `*`.

### Fixed

- A conversation is rebound when the model changes or the Pi session compacts, instead of replaying the old transcript and charging the previous model's quota.
- A turn that stalls after streaming text delivers the recovered answer without duplicating a streamed fragment.
- A stranded escalated result stays on the current conversation and no longer deletes its binding.
- The silent-over-cap and poisoned-conversation guards also classify the late redelivery turn.
- `SessionStore` no longer loses a mutation that lands mid-write.
- Permission dialogs resolve the picked option by identity when labels repeat, and an expired park closes instead of holding the dialog lock.
- Signal cleanup never overrides the host, and a reload replaces its handlers instead of stacking.
- The deferred hard kill keeps the process group in the emergency ledger until the child exits.
- Settled approval tickets are reaped on every decision.
- A redundant turn-end warning toast is no longer raised on turn errors.
- `isAgyInstalled` resolves `PATHEXT` on Windows.
- `@earendil-works/pi-ai` is a declared peer dependency.

---

History up to 1.8.7 belongs to the upstream project: [EstebanForge/pi-extensions](https://github.com/EstebanForge/pi-extensions).
