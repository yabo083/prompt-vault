# Deployment

## Docker Compose

The published image is `ghcr.io/yabo083/prompt-vault`. It installs the same tested npm tarball used by local deployments. The included `compose.yaml` uses a named volume for `/data` and publishes port `8767`.

```bash
curl -LO https://raw.githubusercontent.com/yabo083/prompt-vault/main/compose.yaml
docker compose up -d
docker compose exec prompt-vault cat /data/.vault-token
```

Compose binds to `127.0.0.1` by default. Set `PROMPT_VAULT_BIND=0.0.0.0` only when deliberate LAN exposure is protected by a trusted network or HTTPS proxy.

The first start creates:

- `/data/workspace`: Themes, Drafts, Revisions, and Assets
- `/data/.vault-token`: generated Host Token
- `/data/.vault-auth`: revocable CLI credentials
- `/data/.browser-sessions`: independent browser sessions

Check health and logs with:

```bash
docker compose ps
docker compose logs --tail 100 prompt-vault
curl http://127.0.0.1:8767/healthz
```

### Upgrade

```bash
docker compose pull
docker compose up -d
```

Pin a release by setting `PROMPT_VAULT_VERSION` before `docker compose up`, for example `PROMPT_VAULT_VERSION=1.2.0`.

### Backup

Stop writes, archive the named volume, then restart:

```bash
docker compose stop prompt-vault
docker run --rm \
  -v prompt-vault_prompt-vault-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/prompt-vault-data.tgz -C /data .
docker compose start prompt-vault
```

Test restoration into a separate volume periodically. A backup is not proven until it has been restored and opened successfully.

### Rotate The Generated Host Token

Stop the server, remove only the token file, and restart:

```bash
docker compose stop prompt-vault
docker compose run --rm --no-deps --entrypoint sh prompt-vault -c 'rm -f /data/.vault-token'
docker compose up -d
docker compose exec prompt-vault cat /data/.vault-token
```

Browser sessions and CLI credentials are independent from the Host Token and remain valid after token rotation. To force browser reauthentication, stop the Host and remove `/data/.browser-sessions` before restarting. Each CLI can revoke its own credential with `prompt-vault auth logout`, and Host administrators can use the authenticated credential API for central revocation.

## HTTPS And Public Origin

Bind Prompt Vault to a trusted network or place it behind an authenticated HTTPS reverse proxy. When using a stable external URL, add these variables to a Compose override:

```yaml
services:
  prompt-vault:
    environment:
      PROMPT_VAULT_PUBLIC_URL: https://vault.example.com
      PROMPT_VAULT_TRUSTED_PROXIES: 172.18.0.1
```

Only list proxy IP addresses you operate. `PROMPT_VAULT_PUBLIC_URL` controls secure cookie behavior, same-origin write checks, and CLI approval URLs.

## Source Build

Production requires Node.js 20.20 or newer, compiled server output in `dist`, the browser bundle in `static/dist`, production dependencies, and a writable data directory.

```bash
git clone https://github.com/yabo083/prompt-vault.git
cd prompt-vault
npm ci
npm test
npm run typecheck
npm run build
npm prune --omit=dev
```

Start with environment variables appropriate for the host:

```bash
HOST=127.0.0.1 \
PORT=8767 \
PROMPT_VAULT_WORKSPACE=/var/lib/prompt-vault/workspace \
PROMPT_VAULT_TOKEN_FILE=/var/lib/prompt-vault/.vault-token \
PROMPT_VAULT_CREDENTIAL_DIRECTORY=/var/lib/prompt-vault/.vault-auth \
PROMPT_VAULT_STATIC_DIRECTORY="$PWD/static/dist" \
node dist/server/index.js
```

To build the container from source, first create the canonical tarball that the image installs:

```bash
mkdir -p artifacts
npm pack --workspace @miyako-lab/prompt-vault-cli --pack-destination artifacts
mv artifacts/*.tgz artifacts/prompt-vault.tgz
node scripts/smoke-cli-package.mjs --tarball artifacts/prompt-vault.tgz
docker build -t prompt-vault:local .
```

The Dockerfile intentionally does not rebuild application source. CI and releases pass the same smoke-tested `artifacts/prompt-vault.tgz` to npm publication and the image build.

## systemd

The example unit expects:

- application symlink: `/opt/prompt-vault/current`
- dedicated user and group: `prompt-vault`
- writable data directory: `/var/lib/prompt-vault`
- optional environment file: `/etc/prompt-vault/prompt-vault.env`

Prepare the host, install a built release, and enable the unit:

```bash
VERSION="$(node -p "require('./package.json').version")"
sudo useradd --system --home /var/lib/prompt-vault --shell /usr/sbin/nologin prompt-vault
sudo install -d -o prompt-vault -g prompt-vault /var/lib/prompt-vault
sudo install -d "/opt/prompt-vault/releases/$VERSION" /etc/prompt-vault
sudo cp -a dist static node_modules package.json package-lock.json "/opt/prompt-vault/releases/$VERSION/"
sudo ln -sfn "/opt/prompt-vault/releases/$VERSION" /opt/prompt-vault/current
sudo cp deploy/prompt-vault.service /etc/systemd/system/
sudo install -m 600 deploy/prompt-vault.env.example /etc/prompt-vault/prompt-vault.env
sudo systemctl daemon-reload
sudo systemctl enable --now prompt-vault.service
```

Keep the workspace and credentials outside release directories. Deploy a new version into a versioned directory, atomically update `/opt/prompt-vault/current`, and restart the service.

## Rollback

Application rollback and data rollback are separate decisions.

1. Stop or drain writes.
2. Point the container tag or `/opt/prompt-vault/current` at the previous application release.
3. Restart and perform read-only health, Theme, and Asset checks.
4. Restore workspace data only when it is damaged or a release changed it incompatibly.

Keep a known-good application release and a contemporaneous data backup until a new release has passed real usage.
