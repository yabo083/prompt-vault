# CLI Runtime Design

Status: Reviewed draft, revision 2

Companion review: [CLI Runtime Architecture Review](cli-runtime-architecture-review.md)

## Objective

Ship Prompt Vault as one npm product that supports:

- running a complete Vault Host on the same computer;
- opening and using its compiled Web UI;
- giving agents authenticated CLI access;
- connecting the same CLI to independently deployed Vault Hosts;
- building Docker from the exact same tested npm artifact.

The design follows established foreground-server, native-app authorization, npm packaging, and container-release patterns. It avoids inventing a remote control plane or treating conversational terminology as architecture.

## Runtime Model

Prompt Vault has one kind of application endpoint: Vault Host.

```text
Browser -----> Vault Host -----> filesystem workspace
CLI ----------^       |
                      -> authorization and browser sessions
```

Every Vault Host owns its workspace and is the sole writer. Browser and CLI clients use `/api/v2`.

A Host differs only by lifecycle ownership:

- **Managed Local Host**: the CLI owns a local instance directory and runs the Host in the current terminal.
- **External Host**: another system owns the Host lifecycle; the CLI is only an authenticated HTTP client.

Serving a Managed Local Host does not globally switch the CLI into “local mode.” Connecting to an External Host does not disable the local runtime. Named Hosts and current-Host selection remain orthogonal to lifecycle ownership.

## Primary User Flows

### Fast Local Start

```bash
npm install --global @miyako-lab/prompt-vault-cli
prompt-vault serve
```

When the default instance directory is absent, `serve` initializes it transactionally, starts one full-stack Node process, registers local CLI Authorization, and opens the browser after readiness.

The command remains attached to the terminal. `Ctrl+C` stops the Host.

### Explicit Local Provisioning

```bash
prompt-vault init --directory D:\PromptVault
prompt-vault serve --directory D:\PromptVault --name local
```

`init` exists for custom directories, ports, bind addresses, scripting, and inspecting configuration before execution. It is not mandatory.

### External Host Connection

```bash
prompt-vault connect https://vault.example.com --name production
prompt-vault host use production
prompt-vault theme list
```

The client does not own the External Host lifecycle. Docker, systemd, npm, a cloud platform, or its administrator performs deployment and updates.

## Command Interface

### `prompt-vault init`

```text
--directory <path>   Instance data directory
--bind <address>     Listener; default: 127.0.0.1
--port <port>        Listener port; default: 8767
--public-url <url>   Canonical browser origin
```

Responsibilities:

- create an empty managed instance transactionally;
- reject non-empty unmanaged directories;
- write secret files with owner-only permissions where supported;
- persist a stable instance ID and non-secret runtime configuration;
- remember the default local instance directory;
- never copy application code or run nested npm installation;
- remain idempotent for a valid existing instance without replacing data.

The instance descriptor is written last as the initialization commit marker. Concurrent initialization uses an interprocess lock.

### `prompt-vault serve`

```text
--directory <path>   Override the default instance
--name <name>        Client-local Host alias; default: local
--no-browser         Suppress browser launch
--open               Request browser launch outside an interactive terminal
--use                Select this Host as current
```

Responsibilities:

- lazily call the same initialization module when the default directory is absent;
- invoke the reusable Host module in the same Node process;
- bind the configured listener without port auto-increment;
- verify exact instance identity after readiness;
- create or validate local CLI Authorization when local automatic authorization is permitted;
- register the local Host connection under the client-local alias;
- select it only when no current Host exists or `--use` was passed;
- open the browser only after readiness and only in an interactive terminal;
- print the URL when browser launch fails;
- remain attached and emit logs;
- drain on `SIGINT` and Unix `SIGTERM` with a bounded deadline;
- exit immediately on a second termination signal.

`--no-browser` changes browser behavior only. It does not detach the process or make it a short-lived automation command.

There is no public `start`, `stop`, or detached mode in this revision. Those verbs are reserved for a future complete background lifecycle interface.

### `prompt-vault status`

Reports the selected or explicitly named Host:

```text
--host <name-or-url>   Host override
--check                Exit nonzero unless compatible and healthy
```

Reported facts include URL, reachability, interface compatibility, authentication, and Host identity.

Connection failure is reported as `unavailable` or `indeterminate`; it is not asserted to mean “stopped.”

### Existing Host Commands

- `connect` authorizes and stores an External Host.
- `host list` lists all Host connections and lifecycle ownership metadata.
- `host use` selects the default target for Theme commands.
- `--host` remains a one-command override.

## Instance Data

Default directory:

```text
~/PromptVault
```

Layout:

```text
<instance>/
├── workspace/
└── .prompt-vault/
    ├── instance.json
    ├── .vault-token
    ├── .vault-auth/
    └── .browser-sessions/
```

`instance.json` contains:

- format version;
- stable random instance ID;
- bind address and port;
- canonical public origin;
- creation timestamp.

The directory contains no runtime code. npm upgrades and Docker image replacement do not overwrite it.

## Host Module

The current executable-only server entry becomes a reusable deep module:

```text
startVaultHost(options) -> runningHost
runningHost.ready
runningHost.close()
```

Its interface hides:

- application construction;
- authorization stores;
- browser session stores;
- HTTP routing;
- static frontend delivery;
- listener ownership;
- graceful draining.

Callers provide absolute instance paths and runtime asset paths. The module never derives writable data paths from `process.cwd()`.

The direct production entry and CLI adapter both call this module. Docker runs the direct entry; desktop `serve` uses the CLI adapter.

## Listener And Readiness

The actual listener origin is derived from bind address and port. It is used for bind ownership and readiness probes.

`publicUrl` is a canonical origin, not a general URL. It must contain an HTTP or HTTPS scheme and authority only: no credentials, path, query, or fragment.

- A loopback listener may omit `publicUrl`; it defaults to the literal loopback listener origin.
- A non-loopback listener must configure an HTTPS `publicUrl`.
- A loopback listener behind a reverse proxy may configure an HTTPS `publicUrl`, but it no longer qualifies for automatic browser launch authorization.
- Cookie origin checks and authorization links always use canonical `publicUrl`, never the request Host header.
- Forwarded headers are accepted only from explicitly configured trusted proxy addresses.
- Readiness never probes `publicUrl`; it probes the actual listener origin.

The `listen()` result is authoritative:

- successful bind proceeds to readiness;
- `EADDRINUSE` triggers occupant probing;
- matching instance returns a clear already-running result;
- another Prompt Vault instance reports identity mismatch;
- unknown occupant reports address conflict.

Health includes:

```json
{
  "status": "ok",
  "instanceId": "...",
  "version": "..."
}
```

CLI readiness requires the expected instance ID and a compatible Host version.

## Authorization

### Local CLI Authorization

On literal loopback, the CLI and Host are in the same process. The Host authorization module issues or validates one revocable local CLI credential before listening and returns it directly to the CLI adapter.

No local credential-issuance HTTP route or environment bootstrap secret is introduced.

The credential is stored in the platform keyring when available, with a protected file fallback. Serving local does not silently overwrite a current External Host selection.

Automatic local CLI authorization is allowed only when both the listener origin and canonical browser origin use literal loopback hosts. Every other topology follows the normal interactive authorization flow.

### External CLI Authorization

The browser authorization flow follows the security properties of RFC 8628 without claiming full OAuth server conformance:

- high-entropy device code disclosed only to the CLI and retained server-side in protected or hashed form;
- human-visible user code shown in the browser;
- no device code in the verification URL;
- POST token polling with interval and expiry enforcement;
- one-time atomic credential retrieval;
- explicit browser approval or denial;
- long-lived revocable personal CLI credential stored in the keyring.

Remote HTTP is rejected except for literal loopback. Trusted development networks require explicit `--allow-insecure-http` acknowledgement.

### Browser Sessions

The Host Token is an administrator recovery credential, not a browser session ID or a general API bearer credential.

Host Token or local launch authorization is exchanged for an independent browser session:

- opaque random cookie value;
- HttpOnly and SameSite=Strict;
- Secure under HTTPS;
- hashed server-side record;
- expiry and revocation;
- canonical-origin and Fetch Metadata validation for cookie mutations.

Local browser auto-open authorization uses a memory-only launch nonce only when both listener and canonical origins are literal loopback:

- generated per Host launch;
- 256 bits;
- expires in 30–60 seconds;
- one use;
- exact instance and origin binding;
- accepted only on literal loopback;
- removed from the URL fragment immediately by the frontend.

No persistent `.setup-secret` is created.

## Browser First Run

On an interactive local launch:

1. Host binds and reports exact-instance readiness.
2. Host creates a short-lived launch nonce.
3. CLI opens `<canonical-loopback-origin>/#launch=<nonce>`.
4. Frontend reads the nonce into memory.
5. Frontend removes the fragment with `history.replaceState`.
6. Frontend exchanges the retained nonce through a same-origin request.
7. Host creates an independent browser session.
8. Frontend enters the normal library.

For non-loopback or reverse-proxy canonical origins, `serve` may open the normal sign-in page but never attaches a launch nonce. The browser uses an existing session or Host recovery login, and CLI Authorization uses the corrected interactive device flow.

The completion view provides copyable commands for Agent Skill installation and connecting another computer to a deliberately exposed Host. It does not reveal the Host Token or local CLI credential. This onboarding view is a separate product milestone after the session and launch mechanisms are verified; it is not a prerequisite for the runtime security changes.

## npm Package

The public tarball is the canonical release artifact:

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

Packaging rules:

- clean staging directory;
- explicit file allowlist;
- runtime dependencies declared in the public package;
- frontend dependencies compiled into static assets and omitted from runtime dependencies;
- optional native keyring with protected-file fallback;
- no install-time source compilation;
- no nested install in an instance directory;
- packed manifest and SHA-256 verification;
- tarball smoke installation outside the repository.

Updating the global package while a Host is serving is unsupported because static assets may change underneath the old process. The documented sequence is stop with `Ctrl+C`, update npm, then serve again.

## Docker

Docker installs the exact tested npm tarball supplied by CI or the release workflow. It does not independently build the root workspace or copy root `node_modules`.

The image:

- runs the thin direct Host entry, not desktop `serve`;
- uses exec-form command;
- runs as non-root;
- keeps application code immutable;
- writes only to `/data` and temporary storage;
- preserves instance data in a volume;
- carries labels for package version, tarball SHA-256, and Git revision.

Client computers use `prompt-vault connect` and do not manage the container lifecycle.

## Cross-Platform Contract

Supported systems: Windows, macOS, and Linux on Node.js 20.20 or newer.

Normal execution does not rely on Bash, PowerShell, Unix process groups, PID files, shell interpolation, Docker, SSH, or OS background services.

Cross-platform release gates cover:

- paths containing spaces and non-ASCII user directories;
- loopback IPv4 and IPv6 handling;
- browser-open failure recovery;
- `SIGINT` shutdown;
- Windows best-effort console close;
- listener collisions;
- keyring unavailable fallback;
- minimum Node version failure;
- packed tarball execution outside the repository.

## Test Seams

### CLI Process Seam

- lazy initialization and explicit `init`;
- unmanaged-directory refusal;
- serve readiness with real packaged Host;
- no implicit current-Host replacement;
- exact-instance collision detection;
- routine Theme query through the issued local credential;
- interactive and `--no-browser` behavior;
- shutdown semantics and conventional exit codes;
- selected-Host `status` and `--check`.

### HTTP Seam

- instance-aware health;
- independent browser session exchange;
- short-lived one-time local launch nonce;
- corrected device-code separation and one-time token retrieval;
- poll throttling, expiry, approval, denial, and revocation;
- canonical origin and Fetch Metadata checks;
- insecure remote HTTP rejection at the CLI seam.

### Browser Seam

- launch fragment removal before further navigation;
- no secrets in URL requests, localStorage, console, or visible commands;
- setup success and error recovery;
- command copying on desktop and mobile;
- normal session persistence and logout;
- no layout overlap.

### Artifact Seam

- exact tarball contents;
- clean installation into isolated npm prefix;
- serve, static UI, authorization, Theme query, and shutdown;
- Docker image built from the same tarball;
- persistent `/data` across image restart;
- immutable version and digest rollback references.

## Delivery Order

Security defects precede distribution expansion:

1. Correct device authorization secret separation and one-time retrieval.
2. Replace raw Host Token cookies with independent browser sessions.
3. Extract the reusable Host module and instance-aware health.
4. Implement transactional `init` and lazy initialization.
5. Implement foreground `serve` and local internal credential issuance.
6. Implement and verify the local browser launch nonce.
7. Implement the separate onboarding completion view.
8. Produce and smoke-test the canonical npm tarball on all platforms.
9. Build and verify Docker from that tarball.
10. Publish immutable npm and image versions. Promote Docker `latest` first, verify it, then promote npm `latest`; if npm promotion fails, restore Docker `latest` to the previous digest.

## Out Of Scope

- remote deployment lifecycle management;
- SSH or Docker Engine API access;
- permanent management daemon;
- detached local process mode;
- `start`, `stop`, `restart`, or `logs` lifecycle commands;
- OS startup registration;
- automatic HTTPS;
- automatic backups;
- workspace replication between Hosts;
- full OAuth access/refresh token infrastructure;
- changes to Theme, Draft, Revision, Lineage, or Asset semantics.
