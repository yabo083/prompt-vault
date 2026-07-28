# Architecture

## Runtime Shape

Prompt Vault is one Node.js process with three explicit adapters around an application module:

```text
React browser -> Hono HTTP API -> PromptVault application module -> filesystem workspace
CLI client ----^                         |
                                         -> lock/temp storage
```

The server owns all workspace mutations. The browser and CLI use the same `/api/v2` contract and never write workspace files directly.

## Application Module

`src/core/types.ts` defines the public application contract. `src/core/prompt-vault.ts` implements it as the single orchestration boundary for Themes, Drafts, Assets, Revisions, Lineage, trash, statistics, export, and synchronization.

The filesystem representation remains private to this module. Legacy filenames and fields may still appear on disk, but they do not leak into the public domain language. Compatibility reads synthesize missing metadata in memory and leave the source files unchanged.

## Consistency Model

- A Theme has one mutable Draft.
- Save replaces the displayed node atomically while preserving its identity and lineage edges.
- Save As creates a new child Revision and advances the Theme's lineage.
- Continuing a Revision creates or replaces the Draft with an explicit parent Revision.
- Asset blobs are content-addressed and verified when an existing blob is reused.
- Multi-file mutations are protected by a lock and use staging plus atomic replacement.
- Locks live in the operating system temporary directory, allowing reads from a read-only workspace.

A failed publish either leaves the previous state intact or retains the staged blob needed to recover. Revisions are only removable when they are lineage leaves, preventing dangling descendants.

## HTTP Boundary

`src/server/app.ts` maps HTTP requests to application commands and queries. It also owns browser token sign-in, HTTP-only session cookies, same-origin checks for cookie writes, CLI device authorization, static delivery, and stable JSON errors.

## Browser And CLI

`frontend/src/api.ts` is the browser's only server integration boundary. The client can replace a displayed node, save edited content as a child node, and use Continue to derive a Draft from historical content.

`src/cli/index.ts` is an HTTP client. Host aliases, active host selection, and access tokens are user-local configuration; domain data remains on the selected Vault Host. Device authorization is browser-mediated so a CLI never needs the server's shared browser token.

## Verification

The Vitest suite covers application, server, and CLI boundaries. `npm run typecheck` validates application and frontend projects. `npm run build` proves the deployable Node and browser artifacts can be produced from a TypeScript source tree.
