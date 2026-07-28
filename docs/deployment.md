# Deployment

## Production Contract

Production requires Node.js 20 or newer. Python is not an application dependency.

The service needs compiled output in `dist`, the browser bundle in `static/dist`, production dependencies in `node_modules`, a writable workspace, and a strong `PROMPT_VAULT_TOKEN` supplied outside source control.

The checked-in unit `deploy/prompt-vault.service` uses `/root/prompt-vault` as the application directory and `/root/prompt-vault/workspace` as persistent data.

## Pre-Deploy Verification

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --audit-level=low
```

Do not deploy when any command fails.

## Release Procedure

1. Back up the workspace separately from the application directory.
2. Build the release locally or on a staging host.
3. Synchronize application files without replacing `workspace` or server-local environment files.
4. Run `npm ci --omit=dev` when `node_modules` is not included in the release.
5. Install `deploy/prompt-vault.service`, then run `systemctl daemon-reload`.
6. Restart with `systemctl restart prompt-vault.service`.
7. Confirm `systemctl is-active prompt-vault.service` and inspect recent journal output.

The service command is `/usr/bin/node /root/prompt-vault/dist/server/index.js`.

## Smoke Test

Verify `/` and static files load, browser sign-in lists existing Themes, `/api/v2/capabilities` responds, and an existing Revision image loads. Verify CLI browser authorization, `capabilities`, and `auth logout`. A disposable Theme should complete Draft edit, Asset upload, publish, Continue, duplicate, and safe deletion into `.trash`.

Use disposable data for write tests and record IDs before cleanup.

## Rollback

Application rollback and data rollback are separate decisions.

1. Stop the service.
2. Restore the previous application archive and service unit.
3. Restore the workspace only when it is damaged or the release changed data incompatibly.
4. Run `systemctl daemon-reload`, start the service, and repeat read-only smoke checks.

Compatibility reads preserve existing workspaces. Keep a known-good application archive and a contemporaneous workspace archive until a release has passed real usage.

## Security

- Bind to a trusted interface or use an authenticated HTTPS reverse proxy.
- Keep `PROMPT_VAULT_TOKEN` in a protected environment file.
- Protect workspace, configuration, and backup files as sensitive data.
- Cookie writes are same-origin protected, but HTTPS is required across untrusted networks.
