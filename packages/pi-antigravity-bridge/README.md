# pi-antigravity-bridge

> Google Antigravity model provider (Gemini 4 Argon, Gemini 3.8 Flash, and Claude 5.5) and `AskAntigravity` delegation tool for [pi](https://github.com/earendil-works/pi), powered by your subscription quota.

Supports two execution engines selectable directly from the model name:
- **ACP (Official Server):** Google's official server (`agy_acp_server.par`) over JSON-RPC. Supports image inputs and native inline diff cards in Pi.
- **CLI (stream-json):** Persistent `agy` CLI process. Supports Claude models and a full Pi tool bridge via MCP.

---

## Quickstart

### 1. Requirements
Ensure the official Antigravity CLI is installed and authenticated:
```bash
# Verify CLI installation and authentication
agy models
```

### 2. Installation in Pi
```bash
pi install git:github.com/3d24rd0/pi-extensions
```

### 3. Model Selection
Open Pi's model selector:
```bash
/model
```
Choose any model under the `antigravity/` namespace:
- `Gemini 4 Argon (ACP)` or `(CLI)`
- `Gemini 3.8 Flash (ACP)` or `(CLI)`
- `Claude Opus 5.5 (CLI)`
- `Claude Sonnet 5.5 (CLI)`

*(Note: Gemini and Claude models include reasoning effort levels: `low`, `medium`, `high`).*

---

## Models & Engines

| Model | Engine | Input | Pi Tools | Key Features |
|---|---|---|---|---|
| **Gemini 4 Argon (ACP)** | ACP | Text + Image | Yes (via MCP Bridge) | Deep reasoning, native diff cards |
| **Gemini 4 Argon (CLI)** | CLI | Text | Yes (via MCP Bridge) | Deep reasoning via agy CLI |
| **Gemini 3.8 Flash (ACP)** | ACP | Text + Image | Yes (via MCP Bridge) | Low latency, minimal quota usage |
| **Gemini 3.8 Flash (CLI)** | CLI | Text | Yes (via MCP Bridge) | Fast stream-json execution |
| **Claude Opus 5.5 (CLI)** | CLI | Text | Yes (via MCP Bridge) | Advanced Claude reasoning |
| **Claude Sonnet 5.5 (CLI)** | CLI | Text | Yes (via MCP Bridge) | Balanced speed & quality |

---

## `/agy` Commands

Configure and diagnose the provider in real time. Settings persist to `~/.pi/agent/antigravity-bridge/config.json`:

| Command | Description |
|---|---|
| `/agy` | Open interactive settings dialog (TUI). |
| `/agy doctor` | Comprehensive health check: bridge status, driver counters, versions, and paths. |
| `/agy auth` | Launch browser login for the ACP server. |
| `/agy quota` | Show remaining Antigravity subscription quota. |
| `/agy mode accept-edits \| plan` | Set execution mode (default: `accept-edits`). |
| `/agy ask on \| off` | Enable/disable the `AskAntigravity` delegation tool. |
| `/agy bridge all \| mcp \| none` | Control which non-builtin Pi tools are exposed to Antigravity (default: `all`). Builtins stay with agy's own native tools. |
| `/agy tools [hide \| show \| reset]` | Hide specific Pi tools from the model catalog. |
| `/agy clear` | Clear stored conversation bindings (forces fresh sessions). |

---

## Delegation via `AskAntigravity`

Use the built-in `AskAntigravity` tool to delegate tasks to an isolated `agy` instance:
```markdown
AskAntigravity parameters: prompt, model (optional), thinking (optional), includeContext (optional).
```

---

## Permissions & Safety

Defaults, stated plainly:

- **`skipPermissions: true`.** The `agy` engine runs its own tool loop, and its
  native tools are **not** prompted by Pi by default. An Antigravity turn can
  execute commands and write files on this machine.
- **Approval gate off by default.** `approvals.gateMode` is `auto`, which stages
  the gate only when a third-party Pi permission extension is detected. Set
  `AGY_APPROVALS=shadow` to route mutating native tools (`create_file`,
  `write_to_file`, `replace_file_content`, `run_command`, …) through Pi's
  permission flow: an `agy` tool call then parks as a shadow Pi tool and waits
  for your decision. Headless sessions deny.
- **Provider turns cannot be made read-only.** `/agy readonly on` makes provider
  turns refuse to run rather than pretend to enforce review-only: upstream plan
  mode is a no-op and the write executes in the same turn. Enforce read-only with
  Pi tool restrictions or the approval gate.
- **Bridge exposure.** The MCP bridge binds to `127.0.0.1`, requires a per-session
  bearer token (constant-time compare), writes token-bearing files `0600`, and
  exposes only tools in Pi's live active set — never orchestrator internals or
  administrative memory tools.

---

## Runtime Data & Logs

All persistent data is consolidated under a single directory:

```
~/.pi/agent/antigravity-bridge/
├── config.json           # User configuration
├── sessions.json         # Session bindings (Pi <-> agy conversation)
├── models-cache.json     # agy model catalog cache
├── suppression.json      # Cross-process delegation suppression marker
├── ask-context/          # Temporary scratch exports for context inclusion
└── logs/                 # Daily diagnostic logs
    └── YYYY-MM-DD.ndjson
```

- **Privacy:** Prompts, sensitive tool arguments, and secrets are never logged (automatic pattern redaction).
- **Retention:** 14-day automatic pruning.

---

## Acknowledgements & License

Based on the original extension developed by [@EstebanForge](https://github.com/EstebanForge) in [EstebanForge/pi-extensions](https://github.com/EstebanForge/pi-extensions).

Licensed under [MIT](LICENSE).
