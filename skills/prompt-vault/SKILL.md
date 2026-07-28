---
name: prompt-vault
description: Operate Prompt Vault hosts through the prompt-vault CLI. Use when a user wants an agent to inspect or manage prompt Themes, Drafts, Assets, Revisions, Lineage, exports, or Vault Host connections.
---

# Prompt Vault CLI

Use the `prompt-vault` command as the only interaction interface. Always request deterministic JSON with `--json`; never read or edit a Vault Host workspace directly.

## Preflight

1. Run `prompt-vault --version`. If the command is missing, tell the user to install `@miyako-lab/prompt-vault-cli` and stop.
2. Run `prompt-vault --json host list` to discover configured hosts.
3. Select the user-requested host with `--host <name>` on every command. If there is only one configured current host, use its name.
4. Run `prompt-vault --json --host <name> auth status`.
5. After authentication, run `capabilities` and `workspace synchronize`. Report workspace errors before any mutation.

Preflight is complete when the selected host is authenticated, capabilities are readable, and every workspace error has been reported.

## Browser Authorization

For an agent-controlled shell, use the two-step device flow:

```bash
prompt-vault --json --host <url> auth request --name <name>
```

Read `verificationUri`, `userCode`, and `requestId` from `data`. Show the verification URI and code to the user, then wait for the user to confirm approval. Never expose or request the Vault Host's Host Token.

After the user confirms approval, run:

```bash
prompt-vault --json --host <url> auth complete --name <name> --request <requestId>
```

If `data.status` is `pending`, tell the user approval has not reached the host and retry only after they confirm. Authorization is complete when `data.status` is `approved` and `data.authenticated` is `true`.

## Read Before Write

Before changing a Theme, run:

```bash
prompt-vault --json --host <name> theme show <slug>
```

Preserve the returned `baseRevision`, `hasUnsavedChanges`, Draft fields, and Asset names for the operation. For Revision operations, also read the target Revision or Lineage.

Use the command reference in [references/commands.md](references/commands.md) when selecting the exact command.

## Confirmation Gates

Obtain explicit user approval immediately before:

- `draft discard`
- Any `revision continue`, `revision restore`, or `revision delete` command using `--force`
- `theme delete`, even though the host moves the Theme to recoverable trash
- `revision delete`, which permanently removes a leaf Revision
- Reordering or removing Assets when the requested final order is ambiguous

State the selected host, Theme slug, affected Revision or Asset, and whether unsaved Draft work exists. Approval for one target does not authorize another target.

## Mutation Loop

1. Read the current Theme and relevant Revision or Lineage.
2. Resolve ambiguous values with the user before issuing a command.
3. Pass the selected host explicitly and use `--json`.
4. Execute one logical mutation at a time.
5. Re-read the Theme, Revision, Lineage, or downloaded Asset affected by that mutation.
6. Compare the observed result with the user's requested outcome.

A mutation is complete only when the host returns `ok: true` and the follow-up read proves the requested state.

## JSON Contract

Successful commands emit:

```json
{"ok":true,"data":{}}
```

Failures emit:

```json
{"ok":false,"error":{"code":"...","message":"..."}}
```

Use the error `code` for decisions and report the server `message` verbatim. Do not retry `AUTH_REQUIRED`, `INVALID_WORKSPACE`, `NOT_FOUND`, or `USAGE` without changing the command or resolving the stated condition.

## Session Hygiene

Keep a credential when the user expects future agent access. When access was created only for a temporary task, finish with:

```bash
prompt-vault --json --host <name> auth logout
```

Logout is complete when the response reports `authenticated: false`.
