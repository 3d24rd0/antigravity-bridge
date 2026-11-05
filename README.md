<p align="center">
  <img src="assets/logo.png" width="200" alt="Antigravity Bridge">
</p>

<h1 align="center">Antigravity Bridge</h1>

<p align="center">
  <b>Google Antigravity as a Pi model provider.</b><br>
  Gemini 4 Argon, Gemini 3.8 Flash, Claude Sonnet 5.5 and Claude Opus 5.5 on the
  subscription you already pay for.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@3d24rd0/pi-antigravity-bridge"><img src="https://img.shields.io/npm/v/@3d24rd0/pi-antigravity-bridge?labelColor=1A1218&color=F095C8&style=for-the-badge" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1A1218?labelColor=1A1218&color=D7A0B8&style=for-the-badge" alt="MIT"></a>
  <a href="https://pi.dev/packages/@3d24rd0/pi-antigravity-bridge"><img src="https://img.shields.io/badge/Pi-native-F095C8?labelColor=1A1218&style=for-the-badge" alt="Pi-native package"></a>
</p>

---

## What it does

Pi speaks to models. Antigravity only speaks through its own CLI and its own
protocol. This package puts a provider in between:

```
   Pi  ──▶  Antigravity Bridge  ──▶  agy CLI  /  ACP server  ──▶  Google
             │
             └──◀ Pi's tools, served over a localhost MCP bridge
```

- **Two engines, chosen by the model name.** `-acp` drives Google's official ACP
  server (images, native diff cards); `-cli` drives the stream-json `agy` CLI.
- **Pi's tools work.** The model reads files, edits, runs commands and delegates
  to subagents through a localhost bridge — with real Pi cards, not text dumps.
- **No API key.** It rides the Antigravity CLI and server you already signed
  into. No per-token billing, no key to paste.

## Install

```bash
pi install npm:@3d24rd0/pi-antigravity-bridge
```

Then restart Pi. `/agy` appears in the command list and `antigravity/` models
appear in `/model`. Requires **Node ≥ 22** and the
[Antigravity CLI](https://antigravity.google/product/antigravity-cli) signed in
once (`agy models` should list your models).

<details>
<summary>Install from git instead, or by hand</summary>

```bash
pi install git:github.com/3d24rd0/antigravity-bridge
```

Or in `~/.pi/agent/settings.json` (Gentle Shell:
`~/.gentle-shell/agent/settings.json`):

```json
{ "packages": ["npm:@3d24rd0/pi-antigravity-bridge"] }
```

</details>

## Use it

**1. Pick a model.** `/model` → anything under `antigravity/`. The suffix picks
the engine; Pi's thinking toggle picks the reasoning level.

| Model | Engine | Input | Best for |
|---|---|---|---|
| `antigravity/gemini-4-argon-acp` | ACP | text + image | Deep reasoning, native diff cards |
| `antigravity/gemini-3-8-flash-acp` | ACP | text + image | Low latency, light quota use |
| `antigravity/gemini-4-argon-cli` | CLI | text | Same model, stream-json engine |
| `antigravity/gemini-3-8-flash-cli` | CLI | text | Fast execution |
| `antigravity/claude-sonnet-5-5-cli` | CLI | text | Balanced speed and quality |
| `antigravity/claude-opus-5-5-cli` | CLI | text | Advanced Claude reasoning |

Claude models are CLI-only: the ACP server rejects non-Gemini models.

**2. Check the wiring once.**

```bash
/agy doctor     # driver state, CLI and server versions, paths, effective config
/agy quota      # what your subscription has left
```

**3. Just talk.** Provider turns, Pi tools, subagents and review all work. The
first ACP turn downloads Google's server (~1.5 GB) and asks for a second Google
sign-in — one time only, and the `-cli` models skip it entirely.

## `/agy`

Bare `/agy` opens the settings menu. Every setting also exists as a subcommand,
and **Tab completes them**:

```
/agy  doctor  auth  auth-manual  quota  clear  patch-cleanup
      mode  readonly  permissions  timeout  ask  web  bridge  tools
      digest  system-prompt  model  thinking  agent
      tasks  artifacts  subagents  engine  acp-bin
```

```bash
/agy mode accept-edits|plan      # plan is refused, not faked (see Safety)
/agy readonly on|off             # refuse every provider turn
/agy permissions on|off          # native agy tool auto-approval
/agy timeout <1-1440|off>        # overall turn cap
/agy bridge all|mcp|none         # which Pi tools the model can call
/agy tasks [tail <id>]           # background task logs of this conversation
/agy artifacts [open <n|name>]   # files this conversation produced or received
```

Full reference, every flag and every environment variable:
**[docs/how-it-works.md](docs/how-it-works.md)**.

## Safety, up front

- **`agy` runs its own tool loop and is not prompted by Pi by default.** An
  Antigravity turn can execute commands and write files on this machine.
- **The approval gate is opt-in.** `AGY_APPROVALS=shadow` routes mutating native
  tools through Pi's permission flow; headless sessions deny.
- **Read-only is enforced, never promised.** Plan mode cannot be enforced
  upstream, so the bridge refuses provider turns instead of faking it. Use
  `/agy readonly on`, Pi's tool restrictions, or the gate.

Details and threat model: [docs/how-it-works.md#safety](docs/how-it-works.md#safety).

## Requirements

| | |
|---|---|
| **Pi** | Tested against 1.0+; peers are declared `*` (`pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox`) |
| **Node** | ≥ 22 |
| **Antigravity CLI** | `agy`, signed in once (required by the CLI engine and by `AskAntigravity`) |
| **Google account** | with Antigravity access; ACP additionally asks its own sign-in |

## Development

```bash
git clone https://github.com/3d24rd0/antigravity-bridge
cd antigravity-bridge && npm install
npm run check      # tsc --noEmit + vitest
```

The package ships TypeScript and Pi loads it directly: no build step, so `src/`
and `extensions/` are published as written.

## Acknowledgements

Based on the original extension by [@EstebanForge](https://github.com/EstebanForge).
Licensed under [MIT](LICENSE).
