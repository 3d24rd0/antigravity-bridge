# Antigravity Bridge

> Google Antigravity as a Pi model provider: Gemini 4 Argon, Gemini 3.8 Flash,
> Claude Sonnet 5.5, and Claude Opus 5.5, running on your existing Antigravity
> subscription. Runs Pi's tools through Pi's own loop, not a private API.

Published as [`@3d24rd0/pi-antigravity-bridge`](https://www.npmjs.com/package/@3d24rd0/pi-antigravity-bridge):
`pi install npm:@3d24rd0/pi-antigravity-bridge`.

- **Two engines, chosen by the model name.** `-acp` runs Google's official ACP
  server (images, native diff cards); `-cli` runs the stream-json `agy` CLI.
- **Pi tools work.** A localhost MCP bridge lets the model call Pi's tools
  (including subagents and review), with native Pi cards.
- **Your subscription, your login.** No API key to paste: the bridge drives the
  `agy` CLI and the ACP server you already authenticated.

---

## Requirements

| Requirement | Notes |
|---|---|
| **Pi** ≥ 1.0 | Tested against Pi 1.0+; the published peer ranges are `*` (`@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox`). |
| **Node** ≥ 22 | Uses `AbortSignal.timeout`, `toSorted`, and native `fetch`. |
| **Antigravity CLI** (`agy`) | Install from [antigravity.google](https://antigravity.google/product/antigravity-cli) and sign in once. Stream-json turns need it; `/agy doctor` reports its version. |
| Google account with Antigravity access | ACP additionally needs its own sign-in (see below). |

The ACP engine downloads Google's server binary (`agy_acp_server.par`,
~1.5 GB) on first use and asks for a second Google sign-in. That download and
sign-in are one-time and unavoidable: the server is not part of the `agy` CLI.
If you would rather not, use the `-cli` model variants.

Verify the CLI before installing:

```bash
agy models     # lists the models your account can use, and proves you are signed in
```

---

## Installation

Through the Pi CLI:

```bash
# From npm
pi install npm:@3d24rd0/pi-antigravity-bridge

# Or straight from the repository (bundles the same package)
pi install git:github.com/3d24rd0/pi-extensions
```

Or add it to `~/.pi/agent/settings.json` (Gentle Shell:
`~/.gentle-shell/agent/settings.json`) by hand:

```json
{
  "packages": ["npm:@3d24rd0/pi-antigravity-bridge"]
}
```

Restart Pi after installing. The provider registers itself at load; `/agy`
appears in the command list.

---

## Choosing a model

Open `/model` and pick anything under the `antigravity/` namespace. The suffix
selects the engine; the reasoning level is Pi's normal thinking control.

| Pi model id | Engine | Input | Notes |
|---|---|---|---|
| `gemini-4-argon-acp` | ACP | text + image | Deep reasoning, native inline diff cards |
| `gemini-4-argon-cli` | CLI | text | Same model through `agy` |
| `gemini-3-8-flash-acp` | ACP | text + image | Low latency, light quota use |
| `gemini-3-8-flash-cli` | CLI | text | Fast stream-json execution |
| `claude-sonnet-5-5-cli` | CLI | text | Balanced speed and quality |
| `claude-opus-5-5-cli` | CLI | text | Advanced Claude reasoning |

Claude models are CLI-only: the ACP server answers `-32602` for non-Gemini
models. Gemini and Claude models expose the `low` / `medium` / `high` reasoning
levels through Pi's thinking toggle.

The engine is latched at load, so switching applies on the next Pi start. A
fresh install defaults to ACP; an existing config that predates the engine key
keeps stream-json until you choose otherwise.

---

## `/agy` command reference

Settings live in `~/.pi/agent/antigravity-bridge/config.json` and survive
restarts. `/agy` with no arguments opens the interactive settings menu (same
options, stage-then-save-on-close).

**Tab completes the surface:** subcommand names first (`/agy do` → `doctor`),
then the closed value set of the selected one (`/agy mode ` → `accept-edits`,
`plan`).

### Settings

| Command | Description |
|---|---|
| `/agy` | Interactive settings dialog (TUI). |
| `/agy mode accept-edits \| plan` | Execution mode. `plan` is accepted but provider turns are **refused**: the CLI cannot enforce review-only and stages the write anyway (upstream #1181). |
| `/agy readonly on \| off` | Refuses provider turns entirely. The honest way to get read-only is to restrict Pi's tools or use the approval gate. |
| `/agy permissions on \| off` | `on` adds `--dangerously-skip-permissions` for native `agy` tools; `off` lets `agy` ask, which hangs in non-interactive runs. `/agy permissions` with no argument reports the current value. |
| `/agy timeout <minutes> \| off` | Overall turn cap. Default: none on a TTY, 20 minutes headless. |
| `/agy agent <name> \| off` | Custom agent file for stream-json turns (`--agent`). |
| `/agy thinking low \| medium \| high` | Default reasoning level for the `AskAntigravity` tool. |
| `/agy model <slug>` | Default model for the `AskAntigravity` tool. |
| `/agy ask on \| off` | Register the `AskAntigravity` delegation tool. |
| `/agy web on \| off` | Register `agy_web_search` and `agy_read_url` as Pi tools for **any** provider (opt-in: Antigravity sessions already have native web tools, and each call spends quota). |
| `/agy bridge all \| mcp \| none` | Which non-builtin Pi tools the bridge exposes to Antigravity (`all` by default; builtins stay with `agy`'s own tools). |
| `/agy tools [hide \| show \| reset] [name]` | Hide individual Pi tools from the bridge catalog for this session. |
| `/agy digest on \| off` | Send a context digest of Pi-side history on fresh conversations. |
| `/agy system-prompt on \| off` | Carry Pi's system prompt (including `AGENTS.md`) into new `agy` conversations. |
| `/agy clear` | Drop stored conversation bindings (every session starts fresh). |

### Engine and authentication

| Command | Description |
|---|---|
| `/agy engine` | Explains that the engine is selected by the model name (`/model`). |
| `/agy auth` | Prepare the ACP server and open the Google sign-in (browser). |
| `/agy auth-manual` | Print the manual sign-in steps for headless machines. |
| `/agy acp-bin <path \| auto>` | Show or set the ACP server binary path. |

### Diagnostics

| Command | Description |
|---|---|
| `/agy doctor` | Health check: bridge state, driver counters, versions, paths, effective config. |
| `/agy quota` | Remaining Antigravity subscription quota, per model group. |
| `/agy tasks [tail <id>]` | Background task logs of the current conversation (watch-only). |
| `/agy artifacts [open <n \| name>]` | Files the current conversation produced or received. |
| `/agy subagents` | Subagent roster folded from the live turn. |
| `/agy patch-cleanup` | Restore a Pi install still carrying the removed `pi.invokeTool` patch. |

---

## Environment variables

Every `/agy` setting has an `AGY_*` override; the environment wins over the
config file, and is never written back to it.

| Variable | Values | Meaning |
|---|---|---|
| `AGY_ENGINE` | `acp` \| `stream-json` | Default engine (models with `-acp`/`-cli` still win). |
| `AGY_MODE` | `accept-edits` \| `plan` | Execution mode. |
| `AGY_READONLY` | truthy | Refuse provider turns. |
| `AGY_SKIP_PERMISSIONS` | `1` / `true` | Auto-approve native `agy` tools. |
| `AGY_APPROVALS` | `auto` \| `shadow` \| `dedicated` \| `off` | Approval-gate mode (see Safety). |
| `AGY_APPROVALS_MODE` | `ask` \| `allow` \| `deny` | Gate decision policy. |
| `AGY_BRIDGE_TOOLS` | `all` \| `mcp` \| `none` | Bridge catalog. |
| `AGY_ASK_TOOL` | truthy | Register `AskAntigravity`. |
| `AGY_WEB_TOOLS` | truthy | Register the web tools. |
| `AGY_DIGEST` | truthy | Send the context digest. |
| `AGY_SYSTEM_PROMPT` | truthy | Carry Pi's system prompt. |
| `AGY_DEFAULT_MODEL` / `AGY_DEFAULT_THINKING` | slug / level | `AskAntigravity` defaults. |
| `AGY_TURN_TIMEOUT_MIN` / `AGY_INACTIVITY_TIMEOUT_MIN` | minutes or `0` | Turn cap / stall guard. |
| `AGY_ESCALATE_LONG_TOOLS` | names, comma-separated | Extra tools that hold the sync window 120s before escalating to polling. |
| `AGY_AGENT` | name | Custom stream-json agent. |
| `AGY_ACP_BIN` | path | ACP server binary. |
| `AGY_USAGE_ESTIMATE` | `estimate` \| `direct` \| `off` | How token usage is reported. |
| `AGY_BIN` | path | `agy` binary to spawn (default: `agy` on `PATH`). |
| `AGY_EXTRA_ARGS` | raw args | Appended verbatim to every `agy` spawn. |
| `AGY_AGENTS_ROOT` / `AGY_CONVERSATIONS_DIR` | path | Override the agents discovery root and `agy`'s conversation database. |
| `AGY_DEBUG` | `1` | Write the full diagnostic trail (default writes errors only). |

---

## Delegation with `AskAntigravity`

`AskAntigravity` runs one isolated `agy` turn and returns its answer, so you can
delegate work without switching models:

```markdown
AskAntigravity(prompt, model?, thinking?, includeContext?)
```

It is registered unless `askTool` is off. When both this package and
`pi-ask-antigravity` are installed, the bridge wins and the other package
registers nothing, so you never get two tools with the same job.

---

## Safety and permissions

Defaults, stated plainly:

- **`skipPermissions: true`.** `agy` runs its own tool loop, and its native
  tools are **not** prompted by Pi by default. An Antigravity turn can execute
  commands and write files on this machine.
- **The approval gate is opt-in.** `approvals.gateMode` is `auto`, which stages
  the gate only when a third-party Pi permission extension is detected. Set
  `AGY_APPROVALS=shadow` to route mutating native tools (`create_file`,
  `write_to_file`, `replace_file_content`, `run_command`, …) through Pi's
  permission flow: the call parks as a shadow Pi tool and waits for you.
  Headless sessions deny.
- **Provider turns cannot be made read-only.** Plan mode is a no-op upstream and
  the write executes in the same turn, so the bridge refuses instead of faking
  enforcement. Enforce read-only with Pi's tool restrictions or the gate.
- **Bridge exposure.** The MCP bridge binds to `127.0.0.1`, requires a
  per-session bearer token compared in constant time, writes token-bearing files
  `0600`, and exposes only tools in Pi's live active set — never orchestrator
  internals or administrative memory tools.

---

## Runtime data and logs

The bridge's own state lives under one directory:

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
| `~/.local/opt/agy-acp/` | The ACP server binary (~1.5 GB), downloaded on first ACP use. `AGY_ACP_BIN` relocates it. |
| `~/.gemini/antigravity-acp/` | ACP sign-in state: the auth type written on first setup (`oauth-personal` by default) and the server's own credential files. |
| `~/.gemini/config/mcp_config.json` | The per-process bridge entry `agy` reads (stream-json only; swept when the process dies). |
| `~/.gemini/config/agents/pi-bridge-*` | Staged agent files: the system-prompt carrier and the web/delegation reviewers. Removed when the run ends; stale ones swept at startup. |
| `~/.gemini/antigravity-cli/conversations/` | `agy`'s own conversation database, read for artifacts, task logs, and deadline recovery. Never written. |

- **Privacy:** prompt text and bridge tool arguments are not logged. Error
  strings are redacted (API keys, OAuth tokens, `Authorization`/`Cookie`
  headers) and truncated before they reach disk.
- **Volume:** by default only errors are written. `AGY_DEBUG=1` records the full
  trail when you need to diagnose something.
- **Retention:** logs older than 14 days are pruned automatically.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| A warning says the `agy` CLI is missing | Install it and make sure `agy` is on `PATH`, or set `AGY_BIN`. |
| Turns fail with confusing stream errors right after install | `agy` is too old. `/agy doctor` shows the detected version against the minimum. |
| ACP setup fails or the download stalls | `/agy auth` retries; `/agy auth-manual` prints the manual steps. `AGY_ACP_BIN` points at a pre-downloaded server. |
| No sign-in URL appears over SSH | The bridge prints the URL and the `ssh -N -L <port>:127.0.0.1:<port>` command to forward. |
| "MCP tool bridge disabled" | The bridge could not bind or start; `/agy doctor` shows the reason. |
| A tool call answers "STILL RUNNING" | Long calls escalate to a poll handle; Pi keeps executing and the result arrives via `bridge_poll_result`. |
| Anything odd | `AGY_DEBUG=1 pi`, reproduce, then read `~/.pi/agent/antigravity-bridge/logs/<today>.ndjson`. |

---

## Development

```bash
git clone https://github.com/3d24rd0/pi-extensions
cd pi-extensions
npm install
npm run check      # tsc --noEmit + the full vitest suite
```

The package ships TypeScript and is loaded directly by Pi — there is no build
step, so `src/` and `extensions/` are published as written.

---

## Acknowledgements and license

Based on the original extension by [@EstebanForge](https://github.com/EstebanForge)
in [EstebanForge/pi-extensions](https://github.com/EstebanForge/pi-extensions).

Licensed under [MIT](LICENSE).
