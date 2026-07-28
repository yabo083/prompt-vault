# CLI Runtime Architecture Review

Status: Reviewed against mature implementations and primary documentation

## Executive Conclusion

The core direction is sound: one npm package can contain the CLI, Node Host, and compiled Web UI; one Node process can serve the HTTP interface and frontend; the same CLI can operate a Host on the same computer or connect to an independently deployed Host.

Several details in the first draft were not mature patterns. They arose from the conversation rather than established lifecycle and security conventions:

1. A foreground, terminal-attached process should be named `serve`, not `start`.
2. npm already installs the application; a second mandatory `install` command should not represent instance creation.
3. Serving a local Host must not silently replace the user's currently selected Host.
4. “Local mode” and “remote mode” should not be global states. A Vault Host is either CLI-managed locally or externally managed; all Theme operations still use HTTP.
5. The current device authorization flow exposes the credential-retrieval secret through the browser URL and must be corrected before expanding distribution.
6. Docker must consume the exact npm tarball tested in CI, not independently rebuild another product from the same source commit.

## Evidence From Mature Tools

### Foreground Server Naming

- PocketBase uses `pocketbase serve` and delegates durable background lifetime to systemd: <https://pocketbase.io/docs/going-to-production/>.
- Open WebUI separates package installation from `open-webui serve`: <https://docs.openwebui.com/getting-started/quick-start/>.
- code-server separates package installation from server execution and delegates long-running production lifetime to system services: <https://coder.com/docs/code-server/install>.
- JupyterLab runs an attached server that opens the browser: <https://jupyterlab.readthedocs.io/en/stable/getting_started/starting.html>.

These tools demonstrate that serving a complete frontend and backend does not change the process-lifecycle meaning of `serve`. The verb describes an attached network server, not an incomplete backend.

Tools that use `start` generally own a complete detached lifecycle:

- Supabase CLI provides `init`, `start`, `stop`, and `status` for its managed Docker stack: <https://supabase.com/docs/guides/local-development/cli/getting-started>.
- LocalStack provides `start`, `stop`, `restart`, `status`, and `logs` because it manages the Docker lifecycle: <https://docs.localstack.cloud/aws/developer-tools/running-localstack/lstk/>.

Prompt Vault should reserve `start` for a future detached mode that also includes `stop`, `restart`, and `logs`.

### Local State Initialization

`npm install --global` installs the software. A managed workspace directory is configuration and data, not another software installation.

The mature options are:

- lazy initialization on first run;
- an explicit `init` command for provisioning and custom configuration.

Prompt Vault should support both. The common path is one command after npm installation:

```bash
prompt-vault serve
```

An explicit path remains possible:

```bash
prompt-vault init --directory D:\PromptVault
prompt-vault serve
```

### Host Selection

MinIO's client aliases are endpoint configuration independent from server deployment: <https://docs.min.io/community/minio-object-store/reference/minio-mc/mc-alias-set.html>.

Prompt Vault should follow the same separation:

- lifecycle commands act on a Managed Local Host;
- Theme commands act on the selected Vault Host;
- starting or serving a local Host must not unexpectedly redirect commands away from a selected production Host;
- the first local Host may become current only when no current Host exists, or when the user explicitly asks to select it.

## Corrected Product Model

There is one domain object: Vault Host.

A Vault Host has one of two lifecycle ownership models:

- **Managed Local Host**: the CLI owns its local instance directory and can run it in the current terminal.
- **External Host**: Docker, systemd, npm, a cloud platform, or another administrator owns its lifecycle.

Both expose the same `/api/v2` interface. Browser and CLI clients never write workspace files directly.

The CLI does not enter a global local or remote mode. It stores named Host connections and an optional default local instance directory.

## Corrected Command Model

```text
prompt-vault init [--directory PATH] [--name NAME] [--bind ADDRESS] [--port PORT] [--public-url URL]
prompt-vault serve [--directory PATH] [--no-browser] [--use]
prompt-vault connect URL [--name NAME] [--allow-insecure-http]
prompt-vault status [--host NAME]
prompt-vault host list
prompt-vault host use NAME
```

### `init`

`init` creates persistent instance state. It is optional because `serve` lazily initializes an absent default instance directory.

The managed directory contains configuration and data only. It never receives copied source code, `node_modules`, or a nested npm installation.

### `serve`

`serve` runs one complete Node Host in the current terminal. It serves both the compiled React UI and HTTP interface, prints logs, opens the browser after readiness in an interactive terminal, and exits on `Ctrl+C`.

`--no-browser` suppresses browser opening but does not make the blocking process automation-friendly. Docker, systemd, launchd, or another supervisor should own unattended lifetime.

`serve` registers a local Host connection and credential. It selects that Host only when no Host is selected. `--use` explicitly selects it.

### `status`

`status` describes the selected or explicitly named Host: reachability, authentication, identity, and interface compatibility.

HTTP observation cannot prove that a local process is merely “stopped.” Connection failure may mean stopped, blocked, starting, hung, or unreachable. Status should report observable states such as `running`, `unavailable`, `occupied`, `incompatible`, and `indeterminate` rather than claim unknowable lifecycle states.

## Process Architecture

The CLI should call a reusable Host module in the same Node process. Runtime paths are absolute and derived from the managed instance and `import.meta.url`, never the caller's working directory.

Port ownership is decided by the authoritative `listen()` call. Preflight probing cannot eliminate the race before bind. On `EADDRINUSE`, the CLI probes the occupant and distinguishes:

- the expected instance already running;
- another Prompt Vault instance;
- an unknown service.

The CLI never silently increments the configured port.

Graceful shutdown guarantees must be precise:

- `SIGINT`: stop accepting requests and drain with a bounded deadline;
- Unix `SIGTERM`: same behavior;
- Windows terminal close and forced termination: best effort only;
- second termination signal: exit immediately.

Node signal behavior: <https://nodejs.org/docs/latest-v20.x/api/process.html#signal-events>.

Node HTTP shutdown behavior: <https://nodejs.org/docs/latest-v20.x/api/http.html#serverclosecallback>.

Browser opening is best effort and occurs only after exact-instance readiness. Failure prints the URL and leaves the Host running. A maintained cross-platform opener is preferable to shell construction; Vite's implementation uses this pattern: <https://github.com/vitejs/vite/blob/main/packages/vite/src/node/server/openBrowser.ts>.

## Authentication Review

### Existing Device Flow Defect

The current authorization request ID is returned to the CLI, included in the browser verification URL, and accepted by the public polling endpoint. Anyone who obtains that URL can poll and retrieve the resulting CLI credential.

RFC 8628 separates:

- a high-entropy `device_code`, disclosed only to the CLI and stored server-side in protected or hashed form;
- a human-visible `user_code`, safe to show in the browser;
- a verification URL that does not reveal `device_code`.

Source: <https://www.rfc-editor.org/rfc/rfc8628.html>.

The corrected flow must:

1. keep `device_code` out of browser URLs and logs;
2. show only `user_code` in the browser;
3. use a POST token exchange;
4. enforce poll interval and expiry;
5. atomically consume the authorization result;
6. never allow repeated retrieval of the issued credential.

Prompt Vault may keep CLI credentials as long-lived, revocable personal credentials for now. It should not claim full OAuth conformance without access-token expiry and refresh-token rotation.

### Transport Security

Bearer credentials require TLS. RFC 6750: <https://www.rfc-editor.org/rfc/rfc6750.html>.

Remote `connect` should reject plaintext HTTP except literal loopback addresses. An explicit `--allow-insecure-http` escape hatch may support trusted development networks while making the risk visible.

### Local Authorization

A local foreground Host does not need a public HTTP bootstrap endpoint.

The reusable Host module should issue or validate a revocable local CLI credential internally before listening and return it directly to the CLI implementation. This avoids process-environment bootstrap secrets and externally reachable issuance routes.

Automatic local authorization is allowed only for literal loopback binding. A non-loopback bind follows the normal interactive authorization flow.

### Browser Session

The Host Token should not be the browser cookie. It is currently a recovery secret, API bearer credential, and session identifier at the same time.

The Host Token should instead be exchanged for an independent opaque browser session:

- random session value in an HttpOnly, SameSite=Strict cookie;
- only a hash stored server-side;
- expiry and revocation;
- Secure flag under HTTPS;
- canonical origin validation for cookie-authenticated writes.

For local auto-open, use a memory-only launch nonce with a short expiry, one use, exact instance binding, and loopback-only acceptance. Do not persist `.setup-secret` as a long-lived root credential.

Useful native-app guidance: <https://www.rfc-editor.org/rfc/rfc8252.html>.

## Distribution Review

The npm tarball must be the release artifact consumed by every channel.

Recommended package layout:

```text
package/
├── dist/
│   ├── cli/
│   ├── core/
│   └── server/
├── static/
├── package.json
├── npm-shrinkwrap.json
├── README.md
└── LICENSE
```

Requirements:

- clean staging directory for every package build;
- explicit package allowlist;
- ordinary runtime dependencies for Node modules;
- compiled frontend libraries excluded from runtime dependencies;
- publishable `npm-shrinkwrap.json` generated from staged package;
- keyring native package optional with a tested protected-file fallback;
- tarball manifest and SHA-256 verified before publication;
- smoke installation from the tarball on Windows, macOS, and Linux;
- smoke test exercises server startup, static UI, authorization, a Theme query, and shutdown, not only `--version`.

npm package rules: <https://docs.npmjs.com/cli/v11/configuring-npm/package-json/>.

npm shrinkwrap guidance: <https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/>.

### Docker

Docker must install the exact tested tarball in a Linux build stage. It must not rebuild a parallel root application artifact or copy the monorepo root `node_modules`.

The image runs a thin internal Host entry directly. It does not run the desktop `serve` command because browser opening and local credential setup are desktop concerns.

Release order:

1. clean-build one versioned npm tarball;
2. smoke-test the tarball on the supported platforms;
3. build Docker from that exact tarball;
4. test persistent `/data`, static delivery, health, and restart;
5. publish immutable npm version and image digest;
6. promote npm and Docker `latest` aliases only after both channels pass.

Docker build guidance: <https://docs.docker.com/build/building/best-practices/>.

## Decisions Retained

- one Node process serves frontend and HTTP interface;
- Vault Host remains the sole workspace writer;
- npm runtime code is separate from writable instance data;
- External Host lifecycle is out of scope for the connecting CLI;
- no SSH requirement, Docker socket access, or permanent management daemon;
- stable instance identity appears in health responses;
- packed-package and cross-platform tests are release gates;
- Docker and npm use one tested release artifact.

## Decisions Rejected

- mandatory `prompt-vault install` after npm installation;
- naming a foreground process `start` while omitting `stop`;
- treating `--no-browser` as detached or automation-friendly;
- silently selecting local after serving when production was current;
- deriving readiness from `publicUrl` rather than the actual listener;
- persistent setup fragments with no expiry;
- public local credential bootstrap over HTTP;
- putting the raw Host Token in a browser cookie;
- exposing device credential retrieval secrets in verification URLs;
- accepting remote bearer authentication over plaintext HTTP by default;
- Docker independently rebuilding the product from source;
- smoke testing only `--version`;
- promising graceful shutdown for force-kill and Windows console close.

## Final Consistency Resolutions

The reviewed design additionally resolves these follow-up findings:

- automatic browser launch authorization requires both listener and canonical origins to be literal loopback;
- non-loopback listeners require an explicit HTTPS canonical origin and normal interactive authentication;
- `publicUrl` is constrained to a canonical origin and is never used for listener readiness;
- the frontend retains the launch nonce in memory before removing the fragment;
- device code is disclosed only to the CLI while the Host stores a protected representation;
- Host aliases remain client-local and are not persisted in server-owned instance state;
- onboarding command generation is sequenced after runtime authentication, not treated as its prerequisite;
- npm and Docker aliases use ordered promotion with rollback rather than implying cross-registry atomicity.
