# Command-Line Runtime And Client

The `prompt-vault` package runs a Managed Local Host or operates an External Host through `/api/v2`. The Vault Host remains the sole workspace writer.

## Install

Node.js 20.20 or newer is required.

```bash
npm install --global @miyako-lab/prompt-vault-cli
prompt-vault --version
prompt-vault serve
```

To build the CLI from source:

```bash
npm ci
npm run build
node packages/cli/dist/cli/index.js --help
```

## Managed Local Host

The shortest local path is:

```bash
prompt-vault serve
```

The first run transactionally initializes `~/PromptVault`, serves the API and compiled Web UI from one process, authorizes the local CLI, and opens the browser in an interactive terminal. The process remains attached; press `Ctrl+C` to stop it.

Provision an explicit location before serving when needed:

```bash
prompt-vault init --directory D:\PromptVault --port 8767
prompt-vault serve --directory D:\PromptVault --name local
```

Serving local does not replace an already selected External Host unless `--use` is passed. `--no-browser` suppresses browser opening; `--open` requests it outside an interactive terminal. Neither option detaches the Host.

The CLI stores a current Vault Host, similar to a kubectl context or default cloud profile. Routine commands use it automatically. Agent pipes receive a stable machine-readable envelope automatically; use `--json` only to force that format in an interactive terminal and `--host <name-or-url>` only for a one-command override.

Run `prompt-vault` with no arguments to inspect the current Host and authentication state.

## Browser Authorization

For an interactive terminal, start the complete device flow:

```bash
prompt-vault connect https://vault.example.com --name home
```

The CLI opens the Vault Host's approval page and prints a short code. Sign in to the Vault Host, then approve the CLI request. The resulting CLI credential is stored in the operating system keyring when available, with a mode-`0600` file fallback.

The Host Token is never copied into CLI configuration.

### Agent Authorization

Agents whose shell tools do not stream a running process should use the non-blocking two-step flow:

```bash
prompt-vault --host https://vault.example.com auth request --name home
```

The response contains `verificationUri`, `userCode`, and a secret `deviceCode`, but no credential. Keep `deviceCode` out of browser URLs and logs. After the user approves in a browser:

```bash
prompt-vault --host https://vault.example.com auth complete --name home --device-code <deviceCode>
```

A pending approval returns `data.status: "pending"`. A successful completion returns `data.status: "approved"` and stores the CLI credential.

Manage connections with:

```bash
prompt-vault host list
prompt-vault host use home
prompt-vault auth status
prompt-vault auth logout
```

Reauthorizing a host revokes the previous credential when the host is reachable. Logout revokes the server credential before deleting the local copy.

## JSON Contract

When stdout is a pipe, as it is for coding agents and automation, JSON mode is automatic. Interactive terminals can opt in with `--json`.

Successful commands emit:

```json
{"ok":true,"data":{}}
```

Failures emit a non-zero exit code and:

```json
{"ok":false,"error":{"code":"AUTH_REQUIRED","message":"..."}}
```

Automation should branch on `error.code` and report `error.message` without rewriting it.

## Themes And Drafts

```bash
prompt-vault theme list --query "portrait"
prompt-vault theme show <slug>
prompt-vault theme create --title "Release portrait" --tag editorial
prompt-vault theme duplicate <slug>
prompt-vault theme delete <slug>
prompt-vault draft update <slug> --prompt "..." --model "..."
prompt-vault draft discard <slug>
```

Create and update support title, description, category, tags, prompt, negative prompt, notes, model, parameters, reference URLs, favorite state, and archive state. Run the command with `--help` for exact options.

Theme deletion moves the Theme into server-side trash. Draft discard replaces unsaved creative state with the Base Revision and should be treated as destructive.

## Assets

```bash
prompt-vault asset add <slug> reference ./input.png ./guide.jpg
prompt-vault asset reorder <slug> reference input.png guide.jpg
prompt-vault asset remove <slug> reference guide.jpg
prompt-vault asset get <slug> result output.png --output ./downloaded.png
prompt-vault asset get <slug> result output.png --revision 2 --output ./revision.png
```

## Revisions And Lineage

```bash
prompt-vault revision save <slug> --note "Initial direction"
prompt-vault revision show <slug> 1
prompt-vault revision continue <slug> 1
prompt-vault revision restore <slug> 1 --force
prompt-vault revision compare <slug> 1 2
prompt-vault revision mark <slug> 2 --featured true --favorite true
prompt-vault revision delete <slug> 2
prompt-vault lineage show <slug>
```

Continue changes the Draft's Base Revision. Restore copies historical content into the existing Draft without changing its lineage base. Both protect unsaved Draft work unless `--force` is explicitly passed.

Only a leaf Revision can be deleted. Revision deletion is permanent.

## Host Operations

```bash
prompt-vault capabilities
prompt-vault statistics
prompt-vault export
prompt-vault workspace synchronize
```

`workspace synchronize` scans Themes for unsaved Drafts and malformed workspace state. It does not perform a client-side filesystem scan.

## Security

- External Vault Hosts require HTTPS. Plaintext remote HTTP requires explicit `--allow-insecure-http` acknowledgement, which is stored with that named Host so later commands can enforce the same transport decision. Existing plaintext Host entries created by older CLI versions must be reconnected with the flag before credentials will be sent.
- Never request, store, or pass the Host Token to the CLI.
- Do not share CLI configuration or keyring entries between users.
- Revoke temporary agent credentials with `auth logout` when the task ends.
