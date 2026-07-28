# Command-Line Client

The `prompt-vault` CLI operates Vault Hosts through `/api/v2`. It never reads or writes a server workspace directly.

## Install

Node.js 20.20 or newer is required.

```bash
npm install --global @miyako-lab/prompt-vault-cli
prompt-vault --version
```

To build the CLI from source:

```bash
npm ci
npm run build:cli
node packages/cli/dist/index.js --help
```

Use `--json` for a stable machine-readable envelope and `--host <name-or-url>` to select a configured Vault Host explicitly.

## Browser Authorization

For an interactive terminal, start the complete device flow:

```bash
prompt-vault --host https://vault.example.com auth login --name home
```

The CLI opens the Vault Host's approval page and prints a short code. Sign in to the Vault Host with its Host Token, then approve the CLI request. The resulting CLI credential is stored in the operating system keyring on macOS and Windows, or in a mode-`0600` configuration file on Linux.

The Host Token is never copied into CLI configuration.

### Agent Authorization

Agents whose shell tools do not stream a running process should use the non-blocking two-step flow:

```bash
prompt-vault --json --host https://vault.example.com auth request --name home
```

The response contains `verificationUri`, `userCode`, and `requestId`, but no credential. After the user approves in a browser:

```bash
prompt-vault --json --host https://vault.example.com auth complete --name home --request <requestId>
```

A pending approval returns `data.status: "pending"`. A successful completion returns `data.status: "approved"` and stores the CLI credential.

Manage connections with:

```bash
prompt-vault --json host list
prompt-vault --json host use home
prompt-vault --json --host home auth status
prompt-vault --json --host home auth logout
```

Reauthorizing a host revokes the previous credential when the host is reachable. Logout revokes the server credential before deleting the local copy.

## JSON Contract

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
prompt-vault --json --host home theme list --query "portrait"
prompt-vault --json --host home theme show <slug>
prompt-vault --json --host home theme create --title "Release portrait" --tag editorial
prompt-vault --json --host home theme duplicate <slug>
prompt-vault --json --host home theme delete <slug>
prompt-vault --json --host home draft update <slug> --prompt "..." --model "..."
prompt-vault --json --host home draft discard <slug>
```

Create and update support title, description, category, tags, prompt, negative prompt, notes, model, parameters, reference URLs, favorite state, and archive state. Run the command with `--help` for exact options.

Theme deletion moves the Theme into server-side trash. Draft discard replaces unsaved creative state with the Base Revision and should be treated as destructive.

## Assets

```bash
prompt-vault --json --host home asset add <slug> reference ./input.png ./guide.jpg
prompt-vault --json --host home asset reorder <slug> reference input.png guide.jpg
prompt-vault --json --host home asset remove <slug> reference guide.jpg
prompt-vault --json --host home asset get <slug> result output.png --output ./downloaded.png
prompt-vault --json --host home asset get <slug> result output.png --revision 2 --output ./revision.png
```

## Revisions And Lineage

```bash
prompt-vault --json --host home revision save <slug> --note "Initial direction"
prompt-vault --json --host home revision show <slug> 1
prompt-vault --json --host home revision continue <slug> 1
prompt-vault --json --host home revision restore <slug> 1 --force
prompt-vault --json --host home revision compare <slug> 1 2
prompt-vault --json --host home revision mark <slug> 2 --featured true --favorite true
prompt-vault --json --host home revision delete <slug> 2
prompt-vault --json --host home lineage show <slug>
```

Continue changes the Draft's Base Revision. Restore copies historical content into the existing Draft without changing its lineage base. Both protect unsaved Draft work unless `--force` is explicitly passed.

Only a leaf Revision can be deleted. Revision deletion is permanent.

## Host Operations

```bash
prompt-vault --json --host home capabilities
prompt-vault --json --host home statistics
prompt-vault --json --host home export
prompt-vault --json --host home workspace synchronize
```

`workspace synchronize` scans Themes for unsaved Drafts and malformed workspace state. It does not perform a client-side filesystem scan.

## Security

- Use HTTPS when the Vault Host crosses an untrusted network.
- Never request, store, or pass the Host Token to the CLI.
- Do not share CLI configuration or keyring entries between users.
- Revoke temporary agent credentials with `auth logout` when the task ends.
