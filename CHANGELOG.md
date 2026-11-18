# Changelog

## [1.4.0]

### Added

- **Reasoning tiers follow agy's own catalog, `xhigh` included.** `agy --help` advertises `low|medium|high|xhigh|max`, but no model in agy's catalog lists `max`, so the bridge ships the four tiers agy actually publishes and treats pi's own `max` level as a clamp to `xhigh` rather than inventing a tier. Every tier suffix now collapses into its base slug, so Gemini 4 Hydrogen is one model whose thinking toggle reaches `xhigh` instead of a second, toggle-less `gemini-4-hydrogen-xhigh` entry. Each model offers only the tiers agy lists for it: `gemini-4-argon` stops at `high`. A model listed with a single tier keeps agy's exact slug and carries no toggle. The `AskAntigravity` delegation tool and its default thinking level follow the same vocabulary (see Changed).
- **`/agy acp-update`, and a notice when one is available.** The install layout already kept one directory per build with `current` as a symlink, but nothing ever asked the registry what the current build was: auto-setup pins the resolved path (`…/1.4.1/agy_acp_server.par`) in `acp.bin`, so an installed build stayed forever. `acp-update` compares that build with the registry (cached for six hours), installs the newer one next to the old, starts it once to prove it answers `initialize`, and only then moves `current` and the pin; a build that does not start never becomes current, and the previous one is never deleted, so rollback is a path away. A pin outside the managed root is reported, never rewritten. At startup the bridge does one cached registry check for users who already run ACP and says a line when a newer build exists: nothing downloads on its own. `/agy doctor` still shows the binary and its build.
- **`/agy engine` is gone, and `/agy auth` no longer sends you to it.** The engine is chosen by the model name (`gemini-4-argon-acp` vs `-cli`), which the provider already honoured, so the subcommand had degenerated into a message that changed nothing while the usage line still advertised `engine stream-json|acp`. Worse, `/agy auth` refused to run unless the *default* engine was `acp` and told the user to run that dead command first. The subcommand is removed, the auth gate with it (signing in is what makes an `-acp` model work, whatever the default is), and the messages that pointed at it now point at `/model`. `AGY_ENGINE`/`config.engine` stay as the default for a model id with no suffix, which the onboarding picker sets and `/agy doctor` now labels as a default rather than the selector.
- **The sign-in uses the methods the server publishes.** The ACP server lists `authMethods` on `initialize`: live probes show `oauth-personal`, `oauth-business` (Gemini Enterprise), `gemini-api-key` and `agent-platform` (formerly Vertex). `authenticate` had `oauth-personal` hardcoded, and this bridge's own bootstrap only configures two types, so `/agy auth` now reads the list and offers the browser ones, defaulting to personal when present, and passes the choice to `authenticate` (the server validates the id: an unknown one is rejected with "Unsupported auth method"). The credential methods are named in the message but not offered: probing showed `gemini-api-key` accepted with no key present, and `agent-platform` needs ADC or a `gcp` settings block this bridge does not write, so offering them would be a claim that cannot be backed. A server that publishes no list keeps the historical default, and a cancelled picker changes nothing.
- **`/agy doctor` names the plan you are signed in with.** Google's ACP server reports it on `session/new` as `_meta.antigravity.tier` (`{"name":"Google AI Pro","id":"g1-pro-tier","upgradeUri":…}`), so the bridge now reads that instead of guessing: doctor shows `plan: Google AI Pro`, and says plainly when there is nothing to show yet (the server answers on the first session) or why it cannot (the CLI engine never reports it). Nothing is derived from the account email or the model list, and a shape change degrades to "not reported" instead of throwing mid-turn.
- **`/agy auth` explains itself, and headless sign-in stops being a scavenger hunt.** The command now detects the environment before starting: on a desktop it says the browser will open and how long it waits, and on a terminal without a browser it offers the two real options (copy the URL and tunnel the loopback port, or use a Gemini API key) instead of a generic warning. The tunnel recipe carries this machine's real user and host, the URL is saved to `acp-auth-urls.log` and named in the guide, and a failed sign-in reprints the link with its tunnel command, so recovering it needs no extra command. Failures are translated into a next step (tunnel not up in time, no usable credentials, binary missing) rather than pointing at another command. In a headless session the guide goes to stderr, where it is still readable.
- **argon and hydrogen reach the picker without a second restart.** The provider now implements `refreshModels`: Pi's model refresh re-reads agy's catalog, persists it to the models cache and returns the freshly derived models, so a catalog that changed after the session's session-start snapshot (an `agy update`, a plan change, a new family) converges in place. A failing agy keeps the current list instead of emptying the picker, a fresh cache costs no spawn, and the spawn stays bounded by the discovery watchdog and output cap.

### Changed

- Every tier a base lists now maps to its own name in `thinkingLevelMap`, and the tiers it does not list map to `null`. Pi treats `xhigh`/`max` as unsupported unless the map mentions them, so this is what keeps an unsupported tier out of the toggle for models like Argon.
- Removed a stale `models.ts` header comment claiming a `HIDDEN_FAMILY_RE` dropped the gpt-oss family. No such filter exists: gpt-oss registers as a fixed `-cli` model because agy lists a single tier for it.
- **`AskAntigravity` and its default thinking level cover agy's whole tier set.** `/agy thinking`, `defaultThinking` and `AGY_DEFAULT_THINKING` accept `low|medium|high|xhigh`, the `thinking`/`effort` tool params no longer clamp `xhigh` down to `high` (pi's `max` still clamps, to `xhigh`), and the alias parser reads `xhigh` as a tier of its base. The per-model invariant is unchanged: a tier is only ever passed when the delegated model lists it, so `xhigh` on a three-tier model resolves to `high` instead of an unsupported `--effort`. The `-xhigh` suffix is now stripped from the base on every gemini/claude slug, which fixes a double-tier argv (`--model …-xhigh --effort xhigh`) that the wider vocabulary would otherwise have produced.
- A configured default now clamps like an explicit tier: with `defaultThinking: "xhigh"`, a model that lists only low/medium/high gets `high` rather than a silent drop to the balanced `medium`.
### Fixed

- **A reload during startup no longer kills pi ([#9](https://github.com/3d24rd0/antigravity-bridge/issues/9)).** `session_start` starts two fire-and-forget promises (agy version check, ACP self-heal) and their callbacks read the captured `ctx` for `hasUI` and `ui.notify`. pi invalidates that ctx on `newSession`, `fork`, `switchSession` or `/reload`, and reading it afterwards throws ("This extension ctx is stale..."), which a promise with no `.catch()` turned into an `uncaughtException` that exited pi. The handler now captures the UI once, synchronously, into a sink (`src/session-ui.ts`) that swallows the stale throw, both startup promises carry a `.catch()` that logs to the daily file log, and the driver-facing notify paths (`activeUi`) go through the same guard. The ACP setup path takes a sink too, so reviving it cannot reintroduce the crash. Diagnosed and reported by @hidalgocaparroscristobal.


## [1.3.1]

### Changed

- Catalog listing: the package description now names what makes this bridge different (Google's own binaries, no reimplemented API, Pi's tools reaching the model) instead of enumerating models that go stale. The logo is cropped to fill its frame.

## [1.3.0]

### Added

- **`AskAntigravity` supports background runs.** `background: true` returns a `bg_` run id at once and the detached `agy -p` keeps going without Pi's per-call abort signal, so Esc no longer touches it. When the run settles, the full answer arrives as one `pi.sendMessage` message (`ask-antigravity-result`, secret-redacted, marked UNTRUSTED, `triggerTurn`) carrying the `conversationId` resume handle. Settling is once-only and happens on stream close, not process exit. New `/agy stop [runId-prefix]` ends a run (no argument: the only running one) and refuses with "already finished; its result is being delivered" while a finished answer is being delivered. One shared registry caps concurrency at 4 and holds one run per `conversationId`, blocking calls included; `session_shutdown` kills in-flight runs silently; `print`/`json` mode refuses background.

### Changed

- Blocking and background runs share one spawn/settle lifecycle, so the delegation-suppression window now spans the whole run (a background run outlives the tool call) and releases exactly once at run end. stdout/stderr buffers are capped at 1M/64k so a long run cannot grow memory.

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
