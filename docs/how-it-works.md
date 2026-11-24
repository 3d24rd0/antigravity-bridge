# How Antigravity Bridge works

The reference for what happens between Pi and Google Antigravity: the two
engines, the tool bridge, the full `/agy` surface, every environment variable,
what lands on disk, and why the safety story is shaped the way it is.

Start with the [README](../README.md) if you only want to install and use it.

---

## Contents

- [Architecture](#architecture)
- [The two engines](#the-two-engines)
- [How Pi's tools reach the model](#how-pis-tools-reach-the-model)
- [Conversation continuity](#conversation-continuity)
- [`/agy` reference](#agy-reference)
- [Environment variables](#environment-variables)
- [Runtime data](#runtime-data)
- [Safety](#safety)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌──────────────┐   provider turns    ┌─────────────────────┐
│      Pi      │ ──────────────────▶ │ Antigravity Bridge  │
│              │ ◀────────────────── │  (this package)     │
│  tools,      │   streamed events   │                     │
│  subagents,  │                     └──────────┬──────────┘
│  review      │                                │ spawn / JSON-RPC
└──────┬───────┘                                ▼
       │                              ┌─────────────────────┐
       │  MCP over 127.0.0.1          │  agy CLI (stream-  │
       └─────────────────────────────▶│  json) or Google's  │
          bearer token, per session   │  ACP server         │
                                      └──────────┬──────────┘
                                                 │ subscription
                                                 ▼
                                              Google
```

Three moving parts:

| Part | File | Job |
|---|---|---|
| **Provider** | `src/provider.ts`, `src/entry.ts` | Registers `antigravity/*` models, turns Pi's request into engine events |
| **Drivers** | `src/driver.ts` (CLI), `src/acp/driver.ts` (ACP) | Own the child process, the protocol, the turn lifecycle |
| **Bridge** | `src/mcp-server.ts`, `src/tool-roundtrips.ts` | Serves Pi's tools to the model over a localhost MCP server |

The engines are interchangeable at that boundary: everything above
`driver-types.ts` depends on the interface, not on a protocol.

## The two engines

### Stream-json (`-cli`)

`agy --print --output-format stream-json` with the prompt on argv or stdin. The
bridge parses line-delimited JSON frames for text, thinking, tool steps and the
terminal result.

- Requires the `agy` CLI, version **≥ 1.1.22** for this mode (`/agy doctor`
  reports the detected version against that floor and warns once per session).
- Registers a per-process entry in `~/.gemini/config/mcp_config.json` so `agy`
  discovers the bridge's MCP server, and removes it when the process dies.
- Carries Pi's system prompt as a staged **agent file** (`--agent`), not on the
  command line: the CLI silently drops any single prompt past ~25 KB, and an
  inline system block routinely crossed that cap.
- The prompt is text-only, so an attached image is staged on disk (0600, one
directory per turn, removed when the turn settles) and the model is told to read
  it with the bridge's `read` tool.

### ACP (`-acp`)

Google's official `agy_acp_server.par`, spawned once and spoken to over
JSON-RPC 2.0 on stdio. Gemini-only: the server rejects non-Gemini models with
`-32602`, which is why every Claude model is `-cli`.

- Downloads ~1.5 GB on first use into `~/.local/opt/agy-acp/`.
- Asks its own Google sign-in (separate from the CLI's), under
  `~/.gemini/antigravity-acp/`.
- No protocol slot for custom agents, so the system prompt rides the prompt text
  here instead of an agent file.
- Supports images natively, and renders `agy`'s tool calls as Pi display cards.
- `session/cancel` is probed once per connection: unsupported servers fall back
  to kill-and-reload teardown.
- Server exits include the native exit code and signal in driver diagnostics.
- Session creation and loading time out after 20 seconds; run `/agy doctor` to
  inspect the connection. The server may still be processing the request. A
  failed load retains the existing fallback to a fresh session on the same
  connection; no new automatic retry is added.

Both engines run the same `agy` binary against the same global config, so
anything `agy` loads on its own (rules, MCP servers, settings) applies to both.

## How Pi's tools reach the model

`agy` has its own tools. Pi has better ones. The bridge exposes Pi's to the
model over a **localhost MCP server**:

```
model calls a tool  ──▶  bridge (MCP)  ──▶  Pi tool executes
        ▲                                        │
        └──────────  result, or a poll handle  ◀─┘
```

- Bound to `127.0.0.1` with a per-session bearer token compared in constant time.
  Token-bearing files are written `0600`.
- The catalog is computed **live** on every `tools/list` and re-checked
  immediately before every `tools/call`: a cached catalog is not authorization.
- Orchestrator internals and administrative memory tools are filtered out;
  delegation, review and the rest of Pi's working set stay available.
- Tool output is clamped at 32,000 characters with an explicit notice, so a
  runaway `cat` cannot poison the context or burn a rolling quota window.

**Long calls escalate.** Anything that outlives the synchronous window returns a
`STILL RUNNING` handle instead of blocking forever; the model polls
`bridge_poll_result`, and results that were never polled are re-delivered at the
next turn boundary rather than stranded.

**Approvals.** When the gate is on, mutating native `agy` tools park as shadow
Pi tools and wait for the human. A staged hook answers `agy`'s side, and the
decision is carried back into the parked call. Expired parks deny; an answer that
arrives late is forgotten, never applied.

## Conversation continuity

Pi and `agy` both keep conversations; the bridge keeps them in step.

| Concern | Mechanism |
|---|---|
| Binding | `sessions.json` maps a Pi session to an `agy` conversation id |
| Context digest | **On by default and self-gating**: Pi-side context (compaction summaries, turns handled by other providers or Pi's own tools) ships only when the delta window is non-empty, and each piece ships once. A fresh conversation (model switch, recreation) gets the full handoff; a pure-Antigravity conversation has an empty delta, so its prompts stay byte-identical and `agy`'s prompt cache keeps hitting. On the CLI the digest is budgeted in UTF-8 bytes under the ~25KB silent-drop cap and skipped when it does not fit |
| System prompt | Staged once per conversation (agent file on CLI, inline on ACP) so the prompt cache survives |
| Model switch | A conversation is bound to the model that created it, so switching rotates the binding |
| Failed turns | The watermark only advances on a clean, non-aborted turn; a `role:timestamp` boundary fingerprint resets the delta window when the transcript was rewritten (`/tree`, `/fork`) |

Both engines report the complete upstream individual-quota notice as a rate-limit
error rather than a successful turn, without advancing the context watermark.
An upper layer may retry or try a fallback; the same account may remain exhausted,
so neither retry nor model fallback is guaranteed to help.

## `/agy` reference

Bare `/agy` opens the interactive settings menu (stage changes, save on close).
Tab completes the surface: subcommands first, then their closed value sets.

Custom settings, choice, artifact and task dialogs provide optional waiting-for-user
metadata to Pi. Pi clears it when the dialog closes; a supporting terminal consumer
can display the waiting state.

### Settings

| Command | Effect |
|---|---|
| `/agy mode accept-edits \| plan` | Execution mode. `plan` is accepted but provider turns are **refused** (see Safety) |
| `/agy readonly on \| off` | Refuse every provider turn, including `AskAntigravity` |
| `/agy permissions on \| off` | Auto-approve native `agy` tools (`--dangerously-skip-permissions`) |
| `/agy timeout <1-1440 \| off>` | Overall turn cap. Default: none on a TTY, 20 min headless |
| `/agy agent <name \| off>` | Custom `agy` agent for CLI turns (`--agent`) |
| `/agy thinking low \| medium \| high \| xhigh` | Default reasoning level for `AskAntigravity`; a model that does not list the tier gets the nearest one it has |
| `/agy model <slug>` | Default model for `AskAntigravity` |
| `/agy ask on \| off` | Register the `AskAntigravity` delegation tool |
| `/agy stop [runId-prefix]` | Stop a background `AskAntigravity` run (no argument: the only running one) |
| `/agy web on \| off` | Register `agy_web_search` / `agy_read_url` for any provider |
| `/agy bridge all \| mcp \| none` | Which Pi tools the bridge exposes |
| `/agy tools [hide \| show <name> \| reset]` | Per-session catalog filtering |
| `/agy digest on \| off` | Ship Pi-side context into `agy` conversations. Default on and self-gating: fresh-conversation handoffs, each compaction summary exactly once, non-agy turns only; empty deltas ship nothing and CLI digests are byte-budgeted under ~25KB |
| `/agy system-prompt on \| off` | Carry Pi's system prompt into `agy` conversations |
| `/agy clear` | Drop stored conversation bindings |

### Engine and authentication

| Command | Effect |
|---|---|
| `/agy auth` | Prepare the ACP server and sign in. Asks the server which sign-in methods your account has and offers the browser ones (`oauth-personal`, `oauth-business` for Gemini Enterprise) with their own wording; credential methods (`gemini-api-key`, `agent-platform`) are named but not driven, since they need credentials and server settings this bridge does not manage. Detects the environment and explains what will happen, prints the exact `ssh -N -L` command for a terminal without a browser, and reprints the URL with the command if the sign-in fails. The method used is written into `settings.json`, so a completed sign-in survives a restart or a server update that rewrites that file. The URL is also saved in `~/.pi/agent/antigravity-bridge/acp-auth-urls.log` |
| `/agy auth-manual` | Print the full manual sign-in reference |
| `/agy acp-bin <path \| auto>` | Show or set the ACP server binary path |

### Diagnostics

| Command | Effect |
|---|---|
| `/agy acp-update` | Install a newer ACP server build. The registry's declared launch `args`/`env` for that platform are recorded with the build (`launch.json`) and used for every spawn, which is how Google's Linux `--uid=` reaches the binary; the new build is started once before it becomes `current` |
| `/agy acp-update` || `/agy doctor` | Bridge state, driver counters, CLI and server versions, signed-in plan (ACP), paths, effective config |
| `/agy quota` | Remaining subscription quota, per model group (also populates Gentle Shell's `/gentle:usage`) |
| `/agy tasks [tail <id>]` | Background-task logs of this conversation (watch-only) |
| `/agy artifacts [open <n \| name>]` | Files this conversation produced or received |
| `/agy subagents` | Subagent roster folded from the live turn |
| `/agy patch-cleanup` | Restore a Pi install still carrying the removed `pi.invokeTool` patch |

`/agy status` is retired: it prints a pointer to `/agy doctor`.

## Environment variables

Every setting has an `AGY_*` override. The environment wins over `config.json`
and is never written back to it.

| Variable | Values | Meaning |
|---|---|---|
| `AGY_ENGINE` | `acp` \| `stream-json` | Default engine for a model id with no `-acp`/`-cli` suffix (every model the bridge registers has one, so normally unused) |
| `AGY_MODE` | `accept-edits` \| `plan` | Execution mode |
| `AGY_READONLY` | truthy | Refuse provider turns |
| `AGY_SKIP_PERMISSIONS` | truthy | Auto-approve native `agy` tools |
| `AGY_APPROVALS` | `auto` \| `shadow` \| `dedicated` \| `off` | Approval-gate mode |
| `AGY_APPROVALS_MODE` | `ask` \| `allow` \| `deny` | Gate decision policy |
| `AGY_BRIDGE_TOOLS` | `all` \| `mcp` \| `none` | Bridge catalog |
| `AGY_ASK_TOOL` | truthy | Register `AskAntigravity` |
| `AGY_WEB_TOOLS` | truthy | Register the web tools |
| `AGY_DIGEST` | `0` \| `false` \| `off` | Send the context digest. Default ON (`1`/`true`/`on` or unset); `digest: false` in `config.json` also disables |
| `AGY_SYSTEM_PROMPT` | truthy | Carry Pi's system prompt |
| `AGY_DEFAULT_MODEL` / `AGY_DEFAULT_THINKING` | slug / level | `AskAntigravity` defaults |
| `AGY_TURN_TIMEOUT_MIN` / `AGY_INACTIVITY_TIMEOUT_MIN` | minutes or `0` | Turn cap / stall guard |
| `AGY_ESCALATE_LONG_TOOLS` | comma-separated names | Extra tools that hold the synchronous window |
| `AGY_AGENT` | name | Custom CLI agent |
| `AGY_ACP_BIN` | path | ACP server binary |
| `AGY_USAGE_ESTIMATE` | `estimate` \| `direct` \| `off` | How token usage is reported |
| `AGY_BIN` | path | `agy` binary to spawn (default: `agy` on `PATH`) |
| `AGY_EXTRA_ARGS` | raw args | Appended verbatim to every `agy` spawn |
| `AGY_AGENTS_ROOT` / `AGY_CONVERSATIONS_DIR` | path | Override the agents root and `agy`'s conversation database |
| `AGY_DEBUG` | `1` | Write the full diagnostic trail (default: errors only) |

`AskAntigravity(prompt, model?, thinking?, includeContext?)` runs one isolated
`agy` turn so you can delegate without switching models. Plan-mode delegations
stage an agent whose toolset has no file-editing tools: the constraint is a
toolset, not a prompt.

`background: true` turns that into a delegated run. The call returns a `bg_` run
id immediately, the detached `agy -p` continues without Pi's per-call abort
signal (Esc cannot kill it), and the run settles once - on stream close, not
process exit, so a late write from a child of `agy` is not truncated. The full
answer then arrives as a single `pi.sendMessage` custom message
(`ask-antigravity-result`, `triggerTurn`) that is secret-redacted, tagged
UNTRUSTED because it reaches the model at user-role authority, and carries the
`conversationId` resume handle. Limits: four concurrent runs; one run per
`conversationId` (blocking calls included, since two turns inside one agy
conversation interleave); stdout and stderr buffers capped at 1M and 64k so a
long run cannot grow memory. `session_shutdown` kills in-flight runs silently
(`/new`, `/resume`, `/fork`, `/reload` all fire it), and `print`/`json` mode
refuses background because the process exits before the wake could arrive. The
MCP-suppression window spans the whole run and releases once, at run end.

## Runtime data

The bridge's own state:

```
~/.pi/agent/antigravity-bridge/
├── config.json              # Settings persisted by /agy
├── sessions.json            # Pi session <-> agy conversation bindings
├── models-cache.json        # Cached `agy models` catalog (short TTL)
├── suppression.json         # Cross-process delegation marker
├── acp-auth-verified.json   # ACP sign-in marker (boolean + timestamp, no credential)
├── ask-context/             # Scratch exports used by includeContext
└── logs/
    └── YYYY-MM-DD.ndjson    # Daily diagnostic log
```

It also touches five paths outside it. None holds bridge settings, but a full
uninstall should remove them:

| Path | What |
|---|---|
| `~/.local/opt/agy-acp/` | The ACP server binary (~1.5 GB) |
| `~/.gemini/antigravity-acp/` | ACP sign-in state and the server's credential files |
| `~/.gemini/config/mcp_config.json` | The per-process bridge entry `agy` reads |
| `~/.gemini/config/agents/pi-bridge-*` | Staged agent files, removed when the run ends |
| `~/.gemini/antigravity-cli/conversations/` | `agy`'s own conversation database (read-only here) |

**Privacy.** Prompt text and bridge tool arguments are not logged. Error strings
are redacted (API keys, OAuth tokens, `Authorization`/`Cookie` headers) and
truncated before they reach disk. Only errors are written unless `AGY_DEBUG=1`.
Logs older than 14 days are pruned automatically.

## Safety

Defaults, stated plainly:

- **`skipPermissions: true`.** `agy` runs its own tool loop, and Pi does not
  prompt for its native tools. An Antigravity turn can execute commands and write
  files on this machine.
- **The approval gate is opt-in.** `approvals.gateMode` is `auto`, which stages
  the gate only when a third-party Pi permission extension is detected. Set
  `AGY_APPROVALS=shadow` to route mutating native tools through Pi's permission
  flow; headless sessions deny.
- **Provider turns cannot be made read-only by `agy` itself.** Plan mode is not
  enforced upstream: the CLI stages a plan, asks, and executes the write in the
  same turn
  ([antigravity-cli#1181](https://github.com/google-antigravity/antigravity-cli/issues/1181)).
  The bridge refuses instead of faking enforcement.
- **The bridge is a localhost service with a token**, never a public endpoint:
  loopback bind, constant-time token comparison, `0600` files.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "The `agy` CLI is missing" | Install it, put `agy` on `PATH`, or set `AGY_BIN` |
| Confusing stream errors right after install | `agy` is too old; `/agy doctor` compares against the floor |
| ACP setup fails or the download stalls | `/agy auth` retries; `/agy auth-manual` prints the manual steps |
| ACP turns fail asking for `GEMINI_API_KEY` after a server update | The server's own `settings.json` now declares `gemini-api-key`. If you sign in with Google, setup restores `oauth-personal` on the next ACP start and says so; `/agy doctor` shows the declared method and which credential exists. Set `GEMINI_API_KEY` only if you actually use the metered API key |
| No sign-in URL over SSH | The bridge prints the URL and the `ssh -N -L` forward command |
| "MCP tool bridge disabled" | The server could not bind; `/agy doctor` shows the reason |
| A tool call answers "STILL RUNNING" | It escalated to a poll handle; the result arrives via `bridge_poll_result` |
| Anything odd | `AGY_DEBUG=1 pi`, reproduce, then read `~/.pi/agent/antigravity-bridge/logs/<today>.ndjson` |

### Remote / SSH sign-in

Google redirects the ACP sign-in to a loopback port on the machine running the
bridge, which a browser elsewhere cannot reach on its own. The route that works:

1. Run `/agy auth` on the remote machine. It prints Google's sign-in URL and
   saves a copy in `~/.pi/agent/antigravity-bridge/acp-auth-urls.log`, because
   the notice scrolls away while the command blocks.
2. Forward that loopback port from the machine with the browser, in a second
   terminal, **before** the page redirects:

   ```bash
   ssh -N -L <port>:127.0.0.1:<port> <user>@<host>
   ```

   The exact command, with the real port, user and host, is printed next to the
   URL; nothing has to be filled in by hand.
3. Approve in Google. The browser may finish on an empty page, or on a
   "connection reset"/"connection closed" error — that is normal: the one-shot
   callback listener closes the moment it receives the redirect. The page is not
   the outcome; the `/agy auth` result in the remote terminal is.

If the sign-in times out, rerun `/agy auth` (the URL in the log file may carry
one-time state that has already been spent) and make sure the tunnel is up
before the redirect lands.

Do **not** try to check the server with `agy_acp_server --version` or
`agy_acp_server --help`: it is a stdio JSON-RPC server, so it answers nothing
outside a handshake and simply hangs or exits. `/agy doctor` reports the
installed version.
