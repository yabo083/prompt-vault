---
name: prompt-vault
description: Operate Prompt Vault hosts through the prompt-vault CLI. Use when a user wants an agent to inspect or manage prompt Themes, Drafts, Assets, Revisions, Lineage, exports, or Vault Host connections.
---

# Prompt Vault CLI

Use the Prompt Vault CLI as the only interaction interface; never read or edit a Vault Host workspace directly. Agent shells receive deterministic JSON automatically because their stdout is non-interactive.

## Command Runner

1. Try `prompt-vault --version`.
2. If the command is unavailable or its version is lower than `1.2.0`, use `npx --yes --package @miyako-lab/prompt-vault-cli@latest prompt-vault` as the command prefix for this task. Do not require a global installation.
3. Use the same runner for every later command in the task.

## Preflight

1. Run `prompt-vault` with no arguments. It reports the current Vault Host and authentication state.
2. If a current authenticated Host exists, use it implicitly. Do not repeat `--host` on routine commands.
3. If no current Host is selected, run `prompt-vault host list`. Select the only configured Host automatically; if several exist and the user did not name one, ask which Host to use. Run `prompt-vault host use <name>` and report the selection.
4. If the requested Host is not current, run `prompt-vault host use <name>` and report the selection.
5. If the current Host is configured but unauthenticated, reuse its reported URL and name with the authorization flow below. Do not ask for the URL again.
6. If `host list` is empty, ask only for the Vault Host URL, use `default` as the local name, then use the authorization flow below.
7. After authentication, run `prompt-vault capabilities` and `prompt-vault workspace synchronize`. Report workspace errors before any mutation.

Preflight is complete when the selected host is authenticated, capabilities are readable, and every workspace error has been reported.

## Browser Authorization

For an agent-controlled shell, use the two-step device flow:

```bash
prompt-vault --host <url> auth request --name <current-name-or-default>
```

Read `verificationUri`, `userCode`, and `requestId` from `data`. Show the verification URI and code to the user, then wait for the user to confirm approval. Never expose or request the Vault Host's Host Token.

After the user confirms approval, run:

```bash
prompt-vault --host <url> auth complete --name <current-name-or-default> --request <requestId>
```

If `data.status` is `pending`, tell the user approval has not reached the host and retry only after they confirm. Authorization is complete when `data.status` is `approved` and `data.authenticated` is `true`.

## Read Before Write

Before changing a Theme, run:

```bash
prompt-vault theme show <slug>
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
3. Use the current Host implicitly. Pass `--host` only for an intentional one-command override.
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
prompt-vault auth logout
```

Logout is complete when the response reports `authenticated: false`.
