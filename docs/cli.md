# Command-Line Client

The `prompt-vault` CLI uses a Vault Host's `/api/v2` API. It never reads or writes a workspace directory directly.

## Build And Run

```bash
npm run build
node dist/cli/index.js --help
```

The installed executable name is `prompt-vault`. Pass `--json` for a stable machine-readable envelope and `--host <name-or-url>` to override the active host.

## Browser Authorization

Authorize a host and store it under a local name:

```bash
prompt-vault --host http://192.168.0.107:8767 auth login --name home
```

The CLI opens the host's approval page and prints its short user code. Sign into the host in the browser and approve the request. The resulting bearer token is stored only in the user's local Prompt Vault CLI configuration.

Manage connections with:

```bash
prompt-vault host list
prompt-vault host use home
prompt-vault auth status
prompt-vault auth logout
```

Re-authenticating revokes the previous credential when the host is reachable. Logout revokes the server credential before deleting the local entry.

## Themes And Drafts

```bash
prompt-vault theme list --query "portrait"
prompt-vault theme show <slug>
prompt-vault theme create --title "Release portrait" --tag editorial
prompt-vault theme duplicate <slug>
prompt-vault theme delete <slug>
```

Create accepts the same Draft fields as update. Run `prompt-vault theme create --help` for title, description, category, tags, prompt, negative prompt, notes, model, parameters, reference URLs, favorite state, and archive state.

```bash
prompt-vault draft update <slug> --prompt "..." --model "..."
prompt-vault draft update <slug> --clear-tags --clear-reference-urls
prompt-vault draft discard <slug>
```

Discard restores the Draft from its Base Revision.

## Assets

Draft image Assets are either `reference` or `result`:

```bash
prompt-vault asset add <slug> reference ./input.png ./guide.jpg
prompt-vault asset reorder <slug> reference input.png guide.jpg
prompt-vault asset remove <slug> reference guide.jpg
prompt-vault asset get <slug> result output.png --output ./downloaded.png
prompt-vault asset get <slug> result output.png --revision 2
```

## Revisions And Lineage

```bash
prompt-vault revision save <slug> --note "Initial direction"
prompt-vault revision show <slug> 1
prompt-vault revision continue <slug> 1
prompt-vault revision restore <slug> 1 --force
prompt-vault revision compare <slug> 1 2
prompt-vault lineage show <slug>
```

`continue` starts a new Draft whose parent is the selected Revision. `restore` copies Revision content into the current Draft without changing its lineage base. Both protect unsaved Draft work unless `--force` is passed.

Revision marks and deletion are external to immutable snapshot content:

```bash
prompt-vault revision mark <slug> 2 --featured true --favorite true
prompt-vault revision mark <slug> 2 --hidden false
prompt-vault revision delete <slug> 2
```

Only a leaf Revision can be deleted. `--force` is required when deleting the current Draft's Base Revision with unsaved changes.

## Host Operations

```bash
prompt-vault capabilities
prompt-vault statistics
prompt-vault export
prompt-vault workspace synchronize
```

`export` emits the current Vault projection as JSON. `workspace synchronize` scans Themes for unsaved Drafts and invalid workspace state; it is a validation/synchronization command, not a direct client-side file scan.

## Security

- Never put the browser shared token in CLI configuration.
- Do not share CLI configuration files because they contain bearer tokens.
- Use HTTPS when the Vault Host crosses an untrusted network.
- Device approval codes are short-lived and single-purpose.
