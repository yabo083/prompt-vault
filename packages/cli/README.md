# @miyako-lab/prompt-vault-cli

Run [Prompt Vault](https://github.com/yabo083/prompt-vault) locally or connect agents to an External Vault Host.

```bash
npm install --global @miyako-lab/prompt-vault-cli
prompt-vault serve
```

Or connect to an independently deployed Host:

```bash
prompt-vault connect https://vault.example.com --name home
prompt-vault
prompt-vault theme list
```

`serve` lazily initializes `~/PromptVault`, runs the full-stack Host in the current terminal, and opens the Web UI. It selects the local Host only when no Host is currently selected unless `--use` is passed. Non-interactive callers receive the stable JSON envelope without passing `--json`.

See the [CLI guide](https://github.com/yabo083/prompt-vault/blob/main/docs/cli.md) for authentication, commands, and automation guidance.
