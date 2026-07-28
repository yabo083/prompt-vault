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

## Quick Start With Docker

Requirements: Docker Engine with Docker Compose.

```bash
mkdir prompt-vault && cd prompt-vault
curl -LO https://raw.githubusercontent.com/yabo083/prompt-vault/main/compose.yaml
docker compose up -d
```

Prompt Vault generates a strong Host Token on first start. Retrieve it from the persistent data volume:

```bash
docker compose exec prompt-vault cat /data/.vault-token
```

Open <http://localhost:8767>, enter the Host Token, and the browser will exchange it for an HTTP-only session cookie.

On Windows PowerShell, download the Compose file with:

```powershell
New-Item -ItemType Directory prompt-vault
Set-Location prompt-vault
Invoke-WebRequest https://raw.githubusercontent.com/yabo083/prompt-vault/main/compose.yaml -OutFile compose.yaml
docker compose up -d
docker compose exec prompt-vault cat /data/.vault-token
```

The named Docker volume contains the workspace, Host Token, and CLI authorization records. Recreating or updating the container does not replace this data.

The default Compose binding accepts connections only from the Docker host. For deliberate LAN exposure, set `PROMPT_VAULT_BIND=0.0.0.0` and protect the connection with a trusted network or HTTPS reverse proxy.

See [Deployment](docs/deployment.md) for upgrades, backups, HTTPS reverse proxies, token rotation, source builds, and systemd installation.

## CLI

Install the standalone client with Node.js 20.20 or newer:

```bash
npm install --global @miyako-lab/prompt-vault-cli
```

Authorize it against a Vault Host:

```bash
prompt-vault connect http://localhost:8767 --name local
prompt-vault
prompt-vault theme list
```

The CLI opens a browser approval page. It never stores the Host Token. Approval creates a separate bearer credential that can be replaced by reauthorizing or revoked with `prompt-vault auth logout`.

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

The Host Token grants administrator browser access. Keep it private and use HTTPS whenever traffic leaves a trusted network. CLI credentials are independently revocable and should not be copied between users.

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
