# Prompt Vault CLI Commands

Every command below should include `--json --host <name>` unless it manages the local host list or starts authorization with a URL.

## Inspect

```bash
prompt-vault --json --host <name> capabilities
prompt-vault --json --host <name> statistics
prompt-vault --json --host <name> theme list --query <text>
prompt-vault --json --host <name> theme show <slug>
prompt-vault --json --host <name> revision show <slug> <revision>
prompt-vault --json --host <name> revision compare <slug> <left> <right>
prompt-vault --json --host <name> lineage show <slug>
prompt-vault --json --host <name> workspace synchronize
prompt-vault --json --host <name> export
```

## Themes And Drafts

```bash
prompt-vault --json --host <name> theme create --title <title> [field options]
prompt-vault --json --host <name> theme duplicate <slug>
prompt-vault --json --host <name> theme delete <slug>
prompt-vault --json --host <name> draft update <slug> [field options]
prompt-vault --json --host <name> draft discard <slug>
```

Use `theme create --help` or `draft update --help` for prompt, negative prompt, notes, model, parameters, tags, reference URLs, favorite state, and archive state.

## Assets

```bash
prompt-vault --json --host <name> asset add <slug> <reference|result> <files...>
prompt-vault --json --host <name> asset reorder <slug> <reference|result> <names...>
prompt-vault --json --host <name> asset remove <slug> <reference|result> <name>
prompt-vault --json --host <name> asset get <slug> <reference|result> <name> --output <path>
prompt-vault --json --host <name> asset get <slug> <reference|result> <name> --revision <id> --output <path>
```

## Revisions

```bash
prompt-vault --json --host <name> revision save <slug> --note <note>
prompt-vault --json --host <name> revision continue <slug> <revision> [--force]
prompt-vault --json --host <name> revision restore <slug> <revision> [--force]
prompt-vault --json --host <name> revision mark <slug> <revision> --featured <boolean> --favorite <boolean> --hidden <boolean>
prompt-vault --json --host <name> revision delete <slug> <revision> [--force]
```

## Connections

```bash
prompt-vault --json host list
prompt-vault --json host use <name>
prompt-vault --json --host <url> auth request --name <name>
prompt-vault --json --host <url> auth complete --name <name> --request <requestId>
prompt-vault --json --host <name> auth status
prompt-vault --json --host <name> auth logout
```
