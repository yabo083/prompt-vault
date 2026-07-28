# Prompt Vault CLI Commands

Commands use the configured current Host. Agent pipes receive the stable JSON envelope automatically. Use `--host <name>` only for an intentional one-command override, and `--json` only to force JSON in an interactive terminal.

## Inspect

```bash
prompt-vault capabilities
prompt-vault statistics
prompt-vault theme list --query <text>
prompt-vault theme show <slug>
prompt-vault revision show <slug> <revision>
prompt-vault revision compare <slug> <left> <right>
prompt-vault lineage show <slug>
prompt-vault workspace synchronize
prompt-vault export
```

## Themes And Drafts

```bash
prompt-vault theme create --title <title> [field options]
prompt-vault theme duplicate <slug>
prompt-vault theme delete <slug>
prompt-vault draft update <slug> [field options]
prompt-vault draft discard <slug>
```

Use `theme create --help` or `draft update --help` for prompt, negative prompt, notes, model, parameters, tags, reference URLs, favorite state, and archive state.

## Assets

```bash
prompt-vault asset add <slug> <reference|result> <files...>
prompt-vault asset reorder <slug> <reference|result> <names...>
prompt-vault asset remove <slug> <reference|result> <name>
prompt-vault asset get <slug> <reference|result> <name> --output <path>
prompt-vault asset get <slug> <reference|result> <name> --revision <id> --output <path>
```

## Revisions

```bash
prompt-vault revision save <slug> --note <note>
prompt-vault revision continue <slug> <revision> [--force]
prompt-vault revision restore <slug> <revision> [--force]
prompt-vault revision mark <slug> <revision> --featured <boolean> --favorite <boolean> --hidden <boolean>
prompt-vault revision delete <slug> <revision> [--force]
```

## Connections

```bash
prompt-vault
prompt-vault connect <url> --name <name>
prompt-vault host list
prompt-vault host use <name>
prompt-vault --host <url> auth request --name <name>
prompt-vault --host <url> auth complete --name <name> --request <requestId>
prompt-vault auth status
prompt-vault auth logout
```
