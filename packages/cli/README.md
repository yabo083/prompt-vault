# @miyako-lab/prompt-vault-cli

Authenticated command-line client for [Prompt Vault](https://github.com/yabo083/prompt-vault).

```bash
npm install --global @miyako-lab/prompt-vault-cli
prompt-vault connect https://vault.example.com --name home
prompt-vault
prompt-vault theme list
```

The current Vault Host is used automatically. Non-interactive callers receive the stable JSON envelope without passing `--json`.

See the [CLI guide](https://github.com/yabo083/prompt-vault/blob/main/docs/cli.md) for authentication, commands, and automation guidance.
