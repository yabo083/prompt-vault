# Prompt Vault

[简体中文](README.zh-CN.md)

Prompt Vault is a self-hosted, file-first workspace for composing prompts, organizing image assets, and preserving prompt experiments as revision lineage.

It combines a React/G6 browser workspace, a Hono API on Node.js, an authenticated CLI, and a portable Agent Skill. The server remains the sole writer of the workspace; browser clients, people, and agents use the same `/api/v2` contract.

## Features

- Compose positive prompts, negative prompts, notes, model names, and generation parameters.
- Attach ordered reference and result images to an editable Draft.
- Save immutable Revisions and visualize their parent/child Lineage on a canvas.
- Continue from, restore, compare, mark, and safely remove Revisions.
- Keep prompt text and metadata in readable files while storing immutable assets by content hash.
- Operate one or more Vault Hosts through a revocable, browser-authorized CLI.
- Give Agent Skills-compatible clients a guarded CLI interaction workflow.

## Quick Start

Requirements: Node.js 20.20 or newer.

```bash
npm install --global @miyako-lab/prompt-vault-cli
prompt-vault serve
```

The first run initializes `~/PromptVault`, starts the complete Node Host in the current terminal, authorizes the local CLI, and opens the Web UI. Press `Ctrl+C` to stop it. Use an explicit data directory when needed:

```bash
prompt-vault init --directory /path/to/PromptVault
prompt-vault serve --directory /path/to/PromptVault
```

The npm package contains the CLI, Node Host, and compiled React UI. Vite and Docker are not required for local use.

For an independently deployed Host, connect the same CLI over HTTPS:

```bash
prompt-vault connect https://vault.example.com --name production
```

The connecting CLI does not manage the External Host lifecycle. Docker, systemd, npm, or the server administrator owns deployment and updates.

### Docker

Docker remains available for an External Host:

```bash
curl -LO https://raw.githubusercontent.com/yabo083/prompt-vault/main/compose.yaml
docker compose up -d
```

See [Deployment](docs/deployment.md) for upgrades, backups, HTTPS reverse proxies, token rotation, source builds, and systemd installation.

## CLI

The same installation runs a local Host and connects to External Hosts:

```bash
npm install --global @miyako-lab/prompt-vault-cli
```

Authorize it against a Vault Host:

```bash
prompt-vault connect http://localhost:8767 --name local
prompt-vault
prompt-vault theme list
```

External authorization opens a browser approval page. The browser sees only a short user code; the secret device code stays with the CLI. Approval creates a separate revocable credential. Remote plaintext HTTP is refused unless `--allow-insecure-http` is explicitly passed for a trusted development network.

The current Vault Host is used automatically. Agent and pipeline stdout receives the stable `{ ok, data }` or `{ ok, error }` envelope automatically; `--json` only forces that format in an interactive terminal. See the [CLI guide](docs/cli.md) for all commands and the two-step agent authorization flow.

## Agent Skill

The repository ships a portable [Agent Skills](https://agentskills.io/) workflow that teaches agents to authenticate, inspect, mutate, and verify Prompt Vault state through the CLI.

Install it for supported clients, including OpenCode, Claude Code, and Codex:

```bash
npx skills add yabo083/prompt-vault --skill prompt-vault -g -a opencode -a claude-code -a codex -y
```

The installer detects supported clients such as OpenCode, Claude Code, and Codex. The skill can use the npm CLI through `npx` when it is not installed globally, discovers the current Host, and asks only for a Vault URL and one-time approval when setup is missing. It requires explicit user confirmation for Draft discard, forced replacement, Theme deletion, and permanent Revision deletion.

## Domain Model

- **Theme** is one prompt exploration and the unit shown in the library.
- **Draft** is the only mutable creative state of a Theme.
- **Revision** is an immutable snapshot saved from a Draft.
- **Lineage** records the parent relationships among Revisions.
- **Asset** is a reference or result image attached to a Draft or Revision.
- **Vault Host** owns a workspace and exposes it through the HTTP interface.

Existing legacy workspaces are projected through compatibility reads and are not rewritten merely by being opened.

## Storage And Security

The workspace contains ordinary directories, Markdown files, and JSON metadata. Revision assets are copied into a content-addressed `.assets/` store and verified by SHA-256. Multi-file mutations use locks, staging, and atomic replacement.

The Host Token is an administrator recovery credential that can create an independent browser session. Keep it private and use HTTPS whenever traffic leaves a trusted network. Browser sessions and CLI credentials are independently revocable and should not be copied between users.

Back up the data volume independently from application releases. Application rollback and workspace rollback are separate operations.

## Development

Requirements: Node.js 20.20 or newer and npm.

```bash
git clone https://github.com/yabo083/prompt-vault.git
cd prompt-vault
npm ci
npm run dev:server
```

Run `npm run dev` in another terminal for the Vite client. The development API listens on `http://127.0.0.1:8768` by default.

```bash
npm test
npm run typecheck
npm run build
```

Architecture, deployment, and CLI contracts are documented under [`docs/`](docs/architecture.md).

## Roadmap

1. **Revision comparison**: improve the comparison workspace for prompt text, metadata, asset ordering, and visual output changes.
2. **PVP share images**: define an open Prompt Vault Picture format consisting of a clean standalone photo plus embedded prompt and generation metadata designed to survive common recompression and incidental image processing.

## License

Prompt Vault is licensed under the [GNU General Public License v3.0 or later](LICENSE).
