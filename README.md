# @3d24rd0/pi-extensions

> Pi packages and extensions by [@3d24rd0](https://github.com/3d24rd0).

The repository is itself a Pi package: installing it from git registers every
extension under `packages/`, with no build step (Pi loads the TypeScript as
shipped).

---

## Packages

| Package | What it does |
|---|---|
| **[`@3d24rd0/pi-antigravity-bridge`](packages/pi-antigravity-bridge)** | Google Antigravity as a Pi model provider: Gemini 4 Argon, Gemini 3.8 Flash, Claude Sonnet 5.5, and Claude Opus 5.5 on your existing subscription. Two engines (`-acp` official server, `-cli` stream-json), a localhost MCP bridge so the models run Pi's tools, and the `AskAntigravity` delegation tool. |

---

## Repository layout

```text
pi-extensions/
├── package.json                  # Workspace root + the Pi package manifest
├── packages/
│   └── pi-antigravity-bridge/    # The published package (extensions/ + src/ + tests/)
├── tsconfig.json                 # Shared strict TypeScript config
└── vitest.config.ts              # Shared test runner config
```

---

## Requirements

- **Pi** ≥ 1.0 (`@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox`
  are peer dependencies).
- **Node** ≥ 22.

Each package documents its own extra requirements — for the bridge, the
[Antigravity CLI](https://antigravity.google/product/antigravity-cli) and a
signed-in Google account.

---

## Installation

Through the Pi CLI:

```bash
# The whole repository (every extension under packages/)
pi install git:github.com/3d24rd0/pi-extensions

# Or a single package from npm
pi install npm:@3d24rd0/pi-antigravity-bridge
```

By hand, in `~/.pi/agent/settings.json` (Gentle Shell:
`~/.gentle-shell/agent/settings.json`):

```json
{
  "packages": ["git:github.com/3d24rd0/pi-extensions"]
}
```

Restart Pi after installing. Remove a package the same way you added it, or
delete its entry from `packages`.

---

## Development

```bash
git clone https://github.com/3d24rd0/pi-extensions
cd pi-extensions
npm install

npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest across every package
npm run check       # both
```

Tests live beside the code they cover, in `packages/<name>/tests/`. The suite
runs the whole repository; use
`npx vitest run packages/pi-antigravity-bridge/tests/<file>` while iterating.

---

## License

[MIT](LICENSE) © Eduardo Martínez Catalá
