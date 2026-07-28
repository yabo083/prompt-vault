# Prompt Vault

Prompt Vault is a file-first prompt workspace for composing prompts on a canvas, managing prompt assets, and preserving immutable revision history. The application is a TypeScript full stack: a React browser client, a Hono API on Node.js, and a host-aware command-line client.

## Domain Model

- **Theme** is a prompt project and the unit shown in the workspace.
- **Draft** is the only mutable prompt state.
- **Revision** is an immutable snapshot published from a Draft.
- **Lineage** records which Revision a new Draft continues from.
- **Asset** is a typed file attached to a Draft or Revision: instruction, reference, result, or supplementary material.
- **Vault Host** owns a workspace and exposes it through the HTTP API.

Public APIs and the UI use these terms consistently. Existing workspaces are read through a compatibility layer, so migration does not require rewriting stored files.

## Architecture

The main boundaries are:

- `src/core`: application module, filesystem repository, compatibility reads, locking, and atomic publication.
- `src/server`: Hono HTTP adapter, browser authentication, CLI device authorization, API routes, and static delivery.
- `src/cli`: `prompt-vault` HTTP client for one or more Vault Hosts.
- `frontend`: React and G6 workspace client.

See [Architecture](docs/architecture.md), [CLI](docs/cli.md), and [Deployment](docs/deployment.md) for the operational details.

## Local Development

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
```

Run the API and Vite client in separate terminals:

```bash
npm run dev:server
npm run dev
```

The API listens on `http://127.0.0.1:8768` and Vite serves the browser client on its displayed development URL. The API creates a random host token in `.vault-token` unless `PROMPT_VAULT_TOKEN` is set.

Useful commands:

```bash
npm test
npm run typecheck
npm run build
npm start
```

`npm run dev:server` starts the Node API and `npm run dev` starts Vite with an API proxy. Restart the API process after server-side edits. `npm run build` produces the browser bundle in `static/dist` and Node output in `dist`.

## Configuration

The server reads:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PROMPT_VAULT_TOKEN` | Browser sign-in token | generated in `.vault-token` |
| `PROMPT_VAULT_TOKEN_FILE` | Generated host token file | `./.vault-token` |
| `PROMPT_VAULT_WORKSPACE` | Workspace directory | `./workspace` |
| `HOST` | Listen address | `127.0.0.1` |
| `PORT` | Listen port | `8768` |

Browser sign-in exchanges the host token for an HTTP-only `prompt_vault_token` cookie; the token is not stored in browser JavaScript storage. Cookie-authenticated writes also require a same-origin request. CLI bearer tokens are issued by the browser approval flow and are stored in the user's Prompt Vault configuration directory.

## Storage

The workspace remains ordinary files and directories. Prompt content and metadata are human-readable, while binary assets are content-addressed for immutable Revisions. Mutations use workspace locks and atomic filesystem operations. Read-only queries do not write into the workspace.

Back up the workspace directory independently of the application installation. A deployment can replace the application without replacing workspace data.

## Deployment

The repository includes a systemd unit at `deploy/prompt-vault.service`. Production runs:

```text
/usr/bin/node /root/prompt-vault/dist/server/index.js
```

Build and validate before deploying. Keep the workspace outside the release replacement path or explicitly exclude it from synchronization. The current production procedure and rollback checks are documented in [Deployment](docs/deployment.md).

## Agent And CLI Support

The `prompt-vault` CLI is the supported automation boundary. It uses the same authenticated `/api/v2` contract as the browser and can inspect and mutate Themes, Drafts, Assets, Revisions, and Lineage without direct filesystem access. CLI authorization requires an interactive browser approval, and the resulting bearer credential is revocable.

An agent can operate a Vault Host through this CLI after authorization. Agents should inspect `capabilities`, `statistics`, and `workspace synchronize` before mutations, preserve unsaved Draft work unless explicitly instructed to force a replacement, and treat Theme deletion as a recoverable move to the host trash.

The repository does not yet ship a portable agent skill. The current local development playbook is intentionally environment-specific and is not part of the public distribution.

## Roadmap

1. Improve Revision comparison: provide a denser, clearer comparison workspace for text, metadata, asset ordering, and visual output changes.
2. Improve share cards: define an open `PVP` image format for a standalone photo that preserves prompt and generation parameters while remaining resilient to common recompression and incidental image processing.
