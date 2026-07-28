#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isIP } from "node:net";
import { basename, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import open from "open";
import { z } from "zod";
import { getDefaultLocalInstance, listHosts, removeLogin, resolveConnection, saveLogin, useHost } from "./config.js";
import { CliError } from "./errors.js";
import { defaultInstanceDirectory, initializeLocalInstance, localListenerOrigin, readLocalInstance, supportsAutomaticLocalAuthorization } from "./local-instance.js";
import { startVaultHost } from "../server/host.js";
import { VERSION } from "./version.js";

type CliOptions = { host?: string; json?: boolean };

const deviceResponseSchema = z.object({
  deviceCode: z.string().min(32),
  userCode: z.string().regex(/^[A-Z0-9]{8}$/),
  verificationUri: z.string().url(),
  expiresIn: z.number().positive().max(3_600),
  interval: z.number().nonnegative().max(30),
});

const approvedResponseSchema = z.object({ status: z.literal("approved"), token: z.string().startsWith("pv_") });

function isCompatibleHostVersion(version: string | undefined) {
  const cliMajor = /^(\d+)\./.exec(VERSION)?.[1];
  const hostMajor = version ? /^(\d+)\./.exec(version)?.[1] : undefined;
  return Boolean(cliMajor && hostMajor && cliMajor === hostMajor);
}

async function fetchHost(input: URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch {
    throw new CliError("HOST_UNREACHABLE", `Could not reach Vault Host ${input.origin}`, 3);
  }
}

async function jsonPayload(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    throw new CliError("INVALID_HOST_RESPONSE", "Vault Host returned invalid JSON", 3);
  }
}

async function request(path: string, options: CliOptions, init: RequestInit = {}) {
  const connection = await resolveConnection(options.host || process.env.PROMPT_VAULT_HOST);
  if (!connection) throw new CliError("HOST_REQUIRED", "A Vault Host is required. Run prompt-vault auth login.", 2);
  if (!connection.token) throw new CliError("AUTH_REQUIRED", `Vault Host ${connection.name} is not authenticated.`, 4);
  assertSecureCredentialTransport(connection.url, connection.allowInsecureHttp);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${connection.token}`);
  const response = await fetchHost(new URL(path, connection.url), {
    ...init,
    headers,
  });
  if (response.status === 204) return null;
  const payload = await jsonPayload(response);
  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string } } | null;
    throw new CliError(body?.error?.code || "HOST_ERROR", body?.error?.message || `Vault Host request failed (${response.status})`, response.status === 401 ? 4 : 1);
  }
  return payload;
}

async function jsonRequest(path: string, options: CliOptions, method: "POST" | "PATCH", data?: unknown) {
  return request(path, options, {
    method,
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function binaryRequest(path: string, options: CliOptions) {
  const connection = await resolveConnection(options.host || process.env.PROMPT_VAULT_HOST);
  if (!connection) throw new CliError("HOST_REQUIRED", "A Vault Host is required. Run prompt-vault auth login.", 2);
  if (!connection.token) throw new CliError("AUTH_REQUIRED", `Vault Host ${connection.name} is not authenticated.`, 4);
  assertSecureCredentialTransport(connection.url, connection.allowInsecureHttp);
  const response = await fetchHost(new URL(path, connection.url), {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  if (!response.ok) {
    const payload = await jsonPayload(response) as { error?: { code?: string; message?: string } } | null;
    throw new CliError(payload?.error?.code || "HOST_ERROR", payload?.error?.message || `Vault Host request failed (${response.status})`, response.status === 401 ? 4 : 1);
  }
  return {
    content: new Uint8Array(await response.arrayBuffer()),
    mime: response.headers.get("Content-Type") || "application/octet-stream",
  };
}

function collect(value: string, previous: string[] | undefined) {
  return [...(previous ?? []), value];
}

function booleanValue(value: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliError("USAGE", "Boolean options must be true or false.", 2);
}

function positiveInteger(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("USAGE", "Revision IDs must be positive integers.", 2);
  return parsed;
}

function portNumber(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new CliError("INVALID_PORT", "Port must be an integer between 1 and 65535", 2);
  return parsed;
}

function collectInteger(value: string, previous: number[] | undefined) {
  return [...(previous ?? []), positiveInteger(value)];
}

function draftPayload(commandOptions: Record<string, unknown>) {
  const fields = ["title", "description", "category", "prompt", "negative", "notes", "model", "params"];
  const payload: Record<string, unknown> = {};
  for (const field of fields) if (commandOptions[field] !== undefined) payload[field] = commandOptions[field];
  for (const field of ["starred", "archived"]) if (commandOptions[field] !== undefined) payload[field] = commandOptions[field];
  if (commandOptions.clearTags) payload.tags = [];
  else if (Array.isArray(commandOptions.tag)) payload.tags = commandOptions.tag;
  if (commandOptions.clearReferenceUrls) payload.referenceUrls = [];
  else if (Array.isArray(commandOptions.referenceUrl)) payload.referenceUrls = commandOptions.referenceUrl;
  return payload;
}

function addDraftOptions(command: Command, titleRequired = false) {
  if (titleRequired) command.requiredOption("--title <title>", "Theme title");
  else command.option("--title <title>", "Theme title");
  command
    .option("--description <text>", "Theme description")
    .option("--category <category>", "Theme category")
    .option("--tag <tag>", "Theme tag; may be repeated", collect)
    .option("--clear-tags", "Remove all Theme tags")
    .option("--prompt <text>", "Positive prompt")
    .option("--negative <text>", "Negative prompt")
    .option("--notes <text>", "Draft notes")
    .option("--model <model>", "Model name")
    .option("--params <params>", "Model parameters")
    .option("--reference-url <url>", "External reference URL; may be repeated", collect)
    .option("--clear-reference-urls", "Remove all external reference URLs")
    .option("--starred <boolean>", "Set favorite state", booleanValue)
    .option("--archived <boolean>", "Set archive state", booleanValue);
  return command;
}

async function openBrowser(url: string, disabled = false) {
  if (disabled || process.env.PROMPT_VAULT_NO_BROWSER === "1") return true;
  try {
    await open(url, { wait: false });
    return true;
  } catch {
    return false;
  }
}

function isLiteralLoopback(hostnameValue: string) {
  const candidate = hostnameValue.replace(/^\[|\]$/g, "");
  return candidate === "::1" || (isIP(candidate) === 4 && candidate.split(".")[0] === "127");
}

function assertSecureCredentialTransport(host: string, allowInsecureHttp = false) {
  const url = new URL(host);
  if (url.protocol === "http:" && !isLiteralLoopback(url.hostname) && !allowInsecureHttp) {
    throw new CliError("INSECURE_HOST", "Refusing to send a Vault Host credential over remote HTTP. Reconnect with --allow-insecure-http only for a trusted development network.", 2);
  }
}

function parseHost(host: string, allowInsecureHttp = false) {
  let hostUrl: URL;
  try {
    hostUrl = new URL(host);
  } catch {
    throw new CliError("INVALID_HOST", "Vault Host must be a valid http or https URL", 2);
  }
  if (!new Set(["http:", "https:"]).has(hostUrl.protocol)) throw new CliError("INVALID_HOST", "Vault Host must use http or https", 2);
  if (hostUrl.username || hostUrl.password || hostUrl.search || hostUrl.hash || (hostUrl.pathname !== "/" && hostUrl.pathname !== "")) {
    throw new CliError("INVALID_HOST", "Vault Host must be an origin without credentials, a path, query, or fragment", 2);
  }
  if (hostUrl.protocol === "http:" && !isLiteralLoopback(hostUrl.hostname) && !allowInsecureHttp) {
    throw new CliError("INSECURE_HOST", "Remote Vault Hosts require HTTPS. Pass --allow-insecure-http only for a trusted development network.", 2);
  }
  const url = hostUrl.toString().replace(/\/$/, "");
  return { hostUrl, url };
}

async function requestLogin(host: string, allowInsecureHttp = false) {
  const { hostUrl, url } = parseHost(host, allowInsecureHttp);
  const created = await fetchHost(new URL("/api/v2/auth/device", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: `Prompt Vault CLI on ${hostname()}` }),
  });
  if (!created.ok) throw new CliError("HOST_ERROR", `Could not start authorization (${created.status})`);
  const parsedDevice = deviceResponseSchema.safeParse(await jsonPayload(created));
  if (!parsedDevice.success) throw new CliError("INVALID_HOST_RESPONSE", "Vault Host returned an invalid authorization contract", 3);
  const device = parsedDevice.data;
  const verificationUrl = new URL(device.verificationUri);
  if (verificationUrl.origin !== hostUrl.origin || !new Set(["http:", "https:"]).has(verificationUrl.protocol)) {
    throw new CliError("INVALID_VERIFICATION_URI", "Vault Host returned a cross-origin verification URL", 3);
  }
  return { url, device };
}

async function saveApprovedLogin(name: string, url: string, token: string, {
  select = true,
  allowInsecureHttp = false,
  ownership = "external",
}: {
  select?: boolean;
  allowInsecureHttp?: boolean;
  ownership?: "managed-local" | "external";
} = {}) {
  try {
    const existing = await resolveConnection(name);
    const saved = await saveLogin(name, url, token, { select, allowInsecureHttp, ownership });
    if (existing?.token && existing.token !== token) {
      try {
        assertSecureCredentialTransport(existing.url, existing.allowInsecureHttp);
        const revoked = await fetchHost(new URL("/api/v2/auth/session", existing.url), {
          method: "DELETE",
          headers: { Authorization: `Bearer ${existing.token}` },
        });
        if (!revoked.ok && revoked.status !== 401) {
          process.stderr.write(`Warning: the previous credential could not be revoked (${revoked.status}).\n`);
        }
      } catch {
        process.stderr.write("Warning: the previous credential could not be revoked because the Vault Host became unreachable.\n");
      }
    }
    return { host: saved.name, url: saved.url, authenticated: true as const };
  } catch (error) {
    const revoked = Promise.resolve()
      .then(() => assertSecureCredentialTransport(url, allowInsecureHttp))
      .then(() => fetchHost(new URL("/api/v2/auth/session", url), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }))
      .then((response) => response.ok || response.status === 401)
      .catch(() => false);
    const message = error instanceof Error ? error.message : "Credential storage failed";
    if (!revoked) {
      throw new CliError("AUTH_RECOVERY_REQUIRED", `${message}. A credential may remain active on the Vault Host; revoke it from the Host administration view before retrying authorization.`, 4);
    }
    throw new CliError("CREDENTIAL_SAVE_FAILED_REVOKED", `${message}. The unused Vault Host credential was revoked.`, 4);
  }
}

async function packagedStaticDirectory() {
  const candidates = [
    new URL("../../static/dist/", import.meta.url),
    new URL("../../../../static/dist/", import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    try {
      await access(path);
      return path;
    } catch {
      // Try the source-workspace layout after the published package layout.
    }
  }
  throw new CliError("RUNTIME_MISSING", "The Prompt Vault Web UI is missing from this installation", 3);
}

async function waitForServeShutdown(running: Awaited<ReturnType<typeof startVaultHost>>) {
  let stopping = false;
  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
      stopping = true;
      process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);
  });
  await running.close();
}

async function completeLogin(host: string, name: string, deviceCode: string, allowInsecureHttp = false, saveOptions: {
  select?: boolean;
  ownership?: "managed-local" | "external";
} = {}) {
  const { url } = parseHost(host, allowInsecureHttp);
  const response = await fetchHost(new URL("/api/v2/auth/device/token", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  if (response.status === 202 || response.status === 429) return { status: "pending" as const, host: name, url };
  if (response.status === 403) throw new CliError("AUTH_DENIED", "Authorization request was denied", 4);
  if (response.status === 410) throw new CliError("AUTH_EXPIRED", "Authorization request expired", 4);
  if (response.status !== 200) throw new CliError("AUTH_FAILED", `Authorization failed (${response.status})`, 4);
  const parsedApproval = approvedResponseSchema.safeParse(await jsonPayload(response));
  if (!parsedApproval.success) throw new CliError("INVALID_HOST_RESPONSE", "Vault Host returned an invalid credential", 3);
  const saved = await saveApprovedLogin(name, url, parsedApproval.data.token, { allowInsecureHttp, ...saveOptions });
  return { status: "approved" as const, ...saved };
}

async function login(host: string, name: string, noBrowser = false, allowInsecureHttp = false, saveOptions: {
  select?: boolean;
  ownership?: "managed-local" | "external";
} = {}) {
  const { url, device } = await requestLogin(host, allowInsecureHttp);
  const verificationUrl = new URL(device.verificationUri);
  process.stderr.write(`Open ${verificationUrl.toString()}\nCode: ${device.userCode}\n`);
  if (!(await openBrowser(verificationUrl.toString(), noBrowser))) process.stderr.write("Browser could not be opened; use the URL above.\n");
  const deadline = Date.now() + device.expiresIn * 1_000;
  while (Date.now() < deadline) {
    const completed = await completeLogin(url, name, device.deviceCode, allowInsecureHttp, saveOptions);
    if (completed.status === "approved") return { ...completed, userCode: device.userCode };
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, device.interval * 1_000)));
  }
  throw new CliError("AUTH_EXPIRED", "Authorization request expired", 4);
}

function output(data: unknown, json: boolean | undefined) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function currentConnectionStatus(selector?: string) {
  const connection = await resolveConnection(selector);
  if (!connection) {
    if (selector) throw new CliError("HOST_REQUIRED", `Unknown Vault Host: ${selector}`, 2);
    const hosts = await listHosts();
    if (hosts.length) {
      return { version: VERSION, configured: true as const, currentHost: null, state: "unselected" as const, authenticated: false as const, hosts: hosts.map((host) => host.name) };
    }
    return { version: VERSION, configured: false as const, currentHost: null, state: "unconfigured" as const, authenticated: false as const };
  }
  type HostHealth = { status?: string; instanceId?: string; version?: string };
  let health: HostHealth | null = null;
  try {
    const response = await fetch(new URL("/healthz", connection.url));
    health = response.ok ? await jsonPayload(response) as HostHealth : null;
  } catch {
    return {
      version: VERSION,
      configured: true as const,
      currentHost: connection.name,
      url: connection.url,
      state: "unavailable" as const,
      reachable: false as const,
      authenticated: false as const,
    };
  }
  if (!connection.token) {
    const interfaceCompatible = health?.status === "ok" && isCompatibleHostVersion(health.version);
    return {
      version: VERSION,
      configured: true as const,
      currentHost: connection.name,
      url: connection.url,
      state: "authentication-required" as const,
      reachable: true as const,
      interfaceCompatible,
      hostVersion: health?.version || null,
      instanceId: health?.instanceId || null,
      authenticated: false as const,
    };
  }
  try {
    const identity = await request("/api/v2/auth/session", { host: connection.name });
    const interfaceCompatible = health?.status === "ok" && isCompatibleHostVersion(health.version);
    return {
      version: VERSION,
      configured: true as const,
      currentHost: connection.name,
      url: connection.url,
      state: interfaceCompatible ? "ready" as const : "incompatible" as const,
      reachable: true as const,
      interfaceCompatible,
      hostVersion: health?.version || null,
      instanceId: health?.instanceId || null,
      authenticated: true as const,
      identity,
    };
  } catch (error) {
    if (error instanceof CliError && error.code === "UNAUTHORIZED") {
      const interfaceCompatible = health?.status === "ok" && isCompatibleHostVersion(health.version);
      return {
        version: VERSION,
        configured: true as const,
        currentHost: connection.name,
        url: connection.url,
        state: "authentication-required" as const,
        reachable: true as const,
        interfaceCompatible,
        hostVersion: health?.version || null,
        instanceId: health?.instanceId || null,
        authenticated: false as const,
      };
    }
    throw error;
  }
}

function outputRootStatus(status: Awaited<ReturnType<typeof currentConnectionStatus>>, json: boolean | undefined) {
  if (json) return output(status, true);
  process.stdout.write(`Prompt Vault ${status.version}\n`);
  if (!status.configured) {
    process.stdout.write("No Vault Host configured.\nConnect with: prompt-vault connect <url>\n");
    return;
  }
  if (!status.currentHost) {
    const hosts = "hosts" in status && Array.isArray(status.hosts) ? status.hosts : [];
    process.stdout.write(`Configured Hosts: ${hosts.join(", ")}\n`);
    process.stdout.write("No current Vault Host selected.\nSelect with: prompt-vault host use <name>\n");
    return;
  }
  process.stdout.write(`Host: ${status.currentHost} (${status.url})\n`);
  process.stdout.write(`Status: ${status.authenticated ? "authenticated" : "authentication required"}\n`);
  process.stdout.write("Next: prompt-vault theme list\n");
}

const program = new Command();
let parserMessage = "";
program
  .name("prompt-vault")
  .description("Operate an authenticated Prompt Vault host")
  .version(VERSION)
  .option("--host <host>", "Vault Host name or URL")
  .option("--json", "Emit deterministic JSON", !process.stdout.isTTY)
  .action(async () => {
    const options = program.opts<CliOptions>();
    outputRootStatus(await currentConnectionStatus(options.host || process.env.PROMPT_VAULT_HOST), options.json);
  });
program.exitOverride();
program.configureOutput({
  writeErr(message) {
    parserMessage += message;
  },
});

program.command("connect")
  .description("Connect and select a Vault Host")
  .argument("<url>", "Vault Host URL")
  .option("--name <name>", "Local host name", "default")
  .option("--no-browser", "Print the approval URL without opening a browser")
  .option("--allow-insecure-http", "Allow credentials over remote HTTP")
  .action(async (url, commandOptions) => {
    output(await login(url, commandOptions.name, Boolean(commandOptions.browser === false), Boolean(commandOptions.allowInsecureHttp)), program.opts<CliOptions>().json);
  });

program.command("init")
  .description("Initialize a managed local Prompt Vault instance")
  .option("--directory <path>", "Managed instance directory", defaultInstanceDirectory)
  .option("--bind <address>", "Listening address", "127.0.0.1")
  .option("--port <port>", "Listening port", portNumber, 8767)
  .option("--public-url <url>", "Browser-facing Vault Host URL")
  .action(async (commandOptions) => {
    output(await initializeLocalInstance({
      directory: commandOptions.directory,
      bind: commandOptions.bind,
      port: commandOptions.port,
      publicUrl: commandOptions.publicUrl,
    }), program.opts<CliOptions>().json);
  });

program.command("serve")
  .description("Run a managed local Prompt Vault Host in the current terminal")
  .option("--directory <path>", "Managed instance directory")
  .option("--name <name>", "Client-local Vault Host name", "local")
  .option("--no-browser", "Do not open the Web UI")
  .option("--open", "Open the Web UI even outside an interactive terminal")
  .option("--use", "Select this Vault Host even when another Host is current")
  .action(async (commandOptions) => {
    const directory = commandOptions.directory || await getDefaultLocalInstance() || defaultInstanceDirectory;
    let managed: Awaited<ReturnType<typeof readLocalInstance>>;
    try {
      managed = await readLocalInstance(directory);
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "INSTANCE_NOT_INITIALIZED") throw error;
      await initializeLocalInstance({ directory, bind: "127.0.0.1", port: 8767 });
      managed = await readLocalInstance(directory);
    }
    const existingAlias = await resolveConnection(commandOptions.name);
    if (existingAlias && existingAlias.url !== managed.instance.publicOrigin) {
      throw new CliError("HOST_NAME_CONFLICT", `Vault Host name ${commandOptions.name} already points to ${existingAlias.url}`, 2);
    }
    const current = await resolveConnection();
    const browserAllowed = commandOptions.browser !== false && (Boolean(commandOptions.open) || Boolean(process.stdout.isTTY));
    const automaticLocalAuthorization = supportsAutomaticLocalAuthorization(managed.instance);
    let running: Awaited<ReturnType<typeof startVaultHost>>;
    try {
      running = await startVaultHost({
        workspace: managed.paths.workspace,
        tokenFile: managed.paths.token,
        credentialDirectory: managed.paths.authorization,
        browserSessionDirectory: managed.paths.browserSessions,
        staticDirectory: await packagedStaticDirectory(),
        hostname: managed.instance.bind,
        port: managed.instance.port,
        publicOrigin: managed.instance.publicOrigin,
        instanceId: managed.instance.id,
        localCredentialLabel: automaticLocalAuthorization ? `Prompt Vault CLI on ${hostname()}` : undefined,
        enableLocalBrowserLaunch: automaticLocalAuthorization && browserAllowed,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        const listener = localListenerOrigin(managed.instance.bind, managed.instance.port);
        try {
          const response = await fetch(new URL("/healthz", listener));
          const occupant = response.ok ? await jsonPayload(response) as { status?: string; instanceId?: string } : null;
          if (occupant?.status === "ok" && occupant.instanceId === managed.instance.id) {
            throw new CliError("ALREADY_RUNNING", `This managed Prompt Vault instance is already running at ${listener}`, 3);
          }
          if (occupant?.status === "ok" && occupant.instanceId) {
            throw new CliError("INSTANCE_MISMATCH", `Another Prompt Vault instance is already using ${managed.instance.bind}:${managed.instance.port}`, 3);
          }
        } catch (probeError) {
          if (probeError instanceof CliError) throw probeError;
        }
        throw new CliError("ADDRESS_IN_USE", `Another process is already using ${managed.instance.bind}:${managed.instance.port}`, 3);
      }
      throw error;
    }
    try {
      const health = await fetchHost(new URL("/healthz", running.url));
      const healthPayload = health.ok ? await jsonPayload(health) as { instanceId?: string; version?: string } : {};
      if (!health.ok || healthPayload.instanceId !== managed.instance.id || !isCompatibleHostVersion(healthPayload.version)) {
        throw new CliError("INSTANCE_MISMATCH", "The local listener did not report the expected Prompt Vault instance", 3);
      }
      const select = Boolean(commandOptions.use) || !current;
      if (running.localCredential) {
        await saveApprovedLogin(commandOptions.name, managed.instance.publicOrigin, running.localCredential.token, { select, ownership: "managed-local" });
      } else {
        await login(managed.instance.publicOrigin, commandOptions.name, !browserAllowed, false, { select, ownership: "managed-local" });
      }
      const browserUrl = running.launchUrl || `${managed.instance.publicOrigin}/`;
      if (browserAllowed && !(await openBrowser(browserUrl))) {
        process.stderr.write(`Browser could not be opened. Open ${browserUrl}\n`);
      }
      output({
        state: "serving",
        directory: managed.paths.root,
        host: commandOptions.name,
        url: managed.instance.publicOrigin,
        instanceId: managed.instance.id,
        version: healthPayload.version,
        selected: select,
      }, program.opts<CliOptions>().json);
      await waitForServeShutdown(running);
    } catch (error) {
      await running.close();
      throw error;
    }
  });

program.command("status")
  .description("Check the selected Vault Host")
  .option("--check", "Exit nonzero unless the Host is authenticated and healthy")
  .action(async (commandOptions) => {
    const options = program.opts<CliOptions>();
    const status = await currentConnectionStatus(options.host || process.env.PROMPT_VAULT_HOST);
    output(status, options.json);
    if (commandOptions.check && (status.state !== "ready" || !status.authenticated)) process.exitCode = 3;
  });

const theme = program.command("theme").description("Inspect Themes");
theme.command("list").option("--query <text>", "Search query", "").action(async (commandOptions) => {
  const options = program.opts<CliOptions>();
  const query = commandOptions.query ? `?q=${encodeURIComponent(commandOptions.query)}` : "";
  output(await request(`/api/v2/themes${query}`, options), options.json);
});
theme.command("show").argument("<slug>").action(async (slug) => {
  const options = program.opts<CliOptions>();
  output(await request(`/api/v2/themes/${encodeURIComponent(slug)}`, options), options.json);
});
addDraftOptions(theme.command("create").description("Create a Theme Draft"), true).action(async (commandOptions) => {
  const options = program.opts<CliOptions>();
  output(await jsonRequest("/api/v2/themes", options, "POST", draftPayload(commandOptions)), options.json);
});
theme.command("duplicate").description("Duplicate the current Draft and Assets without Revision history").argument("<slug>").action(async (slug) => {
  const options = program.opts<CliOptions>();
  output(await jsonRequest(`/api/v2/themes/${encodeURIComponent(slug)}/duplicate`, options, "POST"), options.json);
});
theme.command("delete").description("Move a Theme to the Vault Host trash").argument("<slug>").action(async (slug) => {
  const options = program.opts<CliOptions>();
  await request(`/api/v2/themes/${encodeURIComponent(slug)}`, options, { method: "DELETE" });
  output({ slug, deleted: true, recoverable: true }, options.json);
});

const draft = program.command("draft").description("Edit Theme Drafts");
addDraftOptions(draft.command("update").description("Update a Theme Draft").argument("<slug>"))
  .action(async (slug, commandOptions) => {
    const options = program.opts<CliOptions>();
    const payload = draftPayload(commandOptions);
    if (!Object.keys(payload).length) throw new CliError("USAGE", "Pass at least one Draft field to update.", 2);
    output(await jsonRequest(`/api/v2/themes/${encodeURIComponent(slug)}/draft`, options, "PATCH", payload), options.json);
  });
draft.command("discard").description("Restore a Draft to its Base Revision").argument("<slug>").action(async (slug) => {
  const options = program.opts<CliOptions>();
  output(await jsonRequest(`/api/v2/themes/${encodeURIComponent(slug)}/draft/discard`, options, "POST"), options.json);
});

const asset = program.command("asset").description("Manage Draft Assets");
asset.command("add")
  .description("Add image files to a Draft")
  .argument("<slug>")
  .argument("<kind>", "reference or result")
  .argument("<files...>")
  .action(async (slug, kind, files: string[]) => {
    if (!new Set(["reference", "result"]).has(kind)) throw new CliError("USAGE", "Asset kind must be reference or result.", 2);
    const form = new FormData();
    form.set("kind", kind);
    for (const path of files) {
      let content: Buffer;
      try {
        content = await readFile(path);
      } catch {
        throw new CliError("FILE_NOT_FOUND", `Could not read Asset file ${path}`, 2);
      }
      form.append("files", new Blob([Uint8Array.from(content)]), basename(path));
    }
    const options = program.opts<CliOptions>();
    output(await request(`/api/v2/themes/${encodeURIComponent(slug)}/assets`, options, { method: "POST", body: form }), options.json);
  });
asset.command("remove")
  .description("Remove an image from a Draft")
  .argument("<slug>")
  .argument("<kind>", "reference or result")
  .argument("<name>")
  .action(async (slug, kind, name) => {
    if (!new Set(["reference", "result"]).has(kind)) throw new CliError("USAGE", "Asset kind must be reference or result.", 2);
    const options = program.opts<CliOptions>();
    output(await request(`/api/v2/themes/${encodeURIComponent(slug)}/assets/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, options, { method: "DELETE" }), options.json);
  });
asset.command("reorder")
  .description("Set the complete order of one Draft Asset group")
  .argument("<slug>")
  .argument("<kind>", "reference or result")
  .argument("<names...>")
  .action(async (slug, kind, names: string[]) => {
    if (!new Set(["reference", "result"]).has(kind)) throw new CliError("USAGE", "Asset kind must be reference or result.", 2);
    const options = program.opts<CliOptions>();
    output(await request(`/api/v2/themes/${encodeURIComponent(slug)}/assets/${encodeURIComponent(kind)}/order`, options, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names }),
    }), options.json);
  });
asset.command("get")
  .description("Download a Draft or Revision Asset")
  .argument("<slug>")
  .argument("<kind>", "reference or result")
  .argument("<name>")
  .option("--revision <revision>", "Read from an immutable Revision", positiveInteger)
  .option("--output <path>", "Output file path")
  .action(async (slug, kind, name, commandOptions) => {
    if (!new Set(["reference", "result"]).has(kind)) throw new CliError("USAGE", "Asset kind must be reference or result.", 2);
    const options = program.opts<CliOptions>();
    const revisionPath = commandOptions.revision === undefined ? "" : `/revisions/${commandOptions.revision}`;
    const asset = await binaryRequest(`/api/v2/themes/${encodeURIComponent(slug)}${revisionPath}/assets/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, options);
    const path = resolvePath(commandOptions.output || name);
    await writeFile(path, asset.content);
    output({ path, name, mime: asset.mime, bytes: asset.content.byteLength, revision: commandOptions.revision ?? null }, options.json);
  });

const revision = program.command("revision").description("Manage immutable Revisions");
revision.command("save")
  .description("Save the current Draft as an immutable Revision")
  .argument("<slug>")
  .option("--note <note>", "Revision note")
  .option("--parent <revision>", "Parent Revision ID; may be repeated", collectInteger)
  .action(async (slug, commandOptions) => {
    const options = program.opts<CliOptions>();
    const payload: { note?: string; parentIds?: number[] } = {};
    if (commandOptions.note !== undefined) payload.note = commandOptions.note;
    if (commandOptions.parent !== undefined) payload.parentIds = commandOptions.parent;
    output(await jsonRequest(`/api/v2/themes/${encodeURIComponent(slug)}/revisions`, options, "POST", payload), options.json);
  });
revision.command("show")
  .description("Show one immutable Revision")
  .argument("<slug>")
  .argument("<revision>", "Revision ID", positiveInteger)
  .action(async (slug, revisionId) => {
    const options = program.opts<CliOptions>();
    output(await request(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}`, options), options.json);
  });
revision.command("continue")
  .description("Continue the Draft from a Revision")
  .argument("<slug>")
  .argument("<revision>", "Revision ID", positiveInteger)
  .option("--force", "Discard unsaved Draft changes")
  .action(async (slug, revisionId, commandOptions) => {
    const options = program.opts<CliOptions>();
    output(await jsonRequest(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}/continue`, options, "POST", { force: Boolean(commandOptions.force) }), options.json);
  });
revision.command("restore")
  .description("Restore Revision content into the current Draft")
  .argument("<slug>")
  .argument("<revision>", "Revision ID", positiveInteger)
  .option("--force", "Discard unsaved Draft changes")
  .action(async (slug, revisionId, commandOptions) => {
    const options = program.opts<CliOptions>();
    output(await jsonRequest(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}/restore`, options, "POST", { force: Boolean(commandOptions.force) }), options.json);
  });
revision.command("compare")
  .description("Compare two immutable Revisions")
  .argument("<slug>")
  .argument("<left>", "Left Revision ID", positiveInteger)
  .argument("<right>", "Right Revision ID", positiveInteger)
  .action(async (slug, left, right) => {
    const options = program.opts<CliOptions>();
    output(await request(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/compare?left=${left}&right=${right}`, options), options.json);
  });
revision.command("mark")
  .description("Set external featured, favorite, or hidden marks on a Revision")
  .argument("<slug>")
  .argument("<revision>", "Revision ID", positiveInteger)
  .option("--featured <boolean>", "Set representative status", booleanValue)
  .option("--favorite <boolean>", "Set favorite status", booleanValue)
  .option("--hidden <boolean>", "Set hidden status", booleanValue)
  .action(async (slug, revisionId, commandOptions) => {
    const marks = Object.fromEntries(["featured", "favorite", "hidden"]
      .filter((field) => commandOptions[field] !== undefined)
      .map((field) => [field, commandOptions[field]]));
    if (!Object.keys(marks).length) throw new CliError("USAGE", "Pass at least one Revision mark.", 2);
    const options = program.opts<CliOptions>();
    output(await jsonRequest(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}/marks`, options, "PATCH", marks), options.json);
  });
revision.command("delete")
  .description("Permanently delete a leaf Revision")
  .argument("<slug>")
  .argument("<revision>", "Revision ID", positiveInteger)
  .option("--force", "Discard unsaved Draft changes when deleting its Base Revision")
  .action(async (slug, revisionId, commandOptions) => {
    const options = program.opts<CliOptions>();
    const force = commandOptions.force ? "?force=true" : "";
    output(await request(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}${force}`, options, { method: "DELETE" }), options.json);
  });

const lineage = program.command("lineage").description("Inspect Revision Lineage");
lineage.command("show").argument("<slug>").action(async (slug) => {
  const options = program.opts<CliOptions>();
  output(await request(`/api/v2/themes/${encodeURIComponent(slug)}/lineage`, options), options.json);
});

program.command("capabilities").description("Describe the Vault Host contract and mutation safety rules").action(async () => {
  const options = program.opts<CliOptions>();
  output(await request("/api/v2/capabilities", options), options.json);
});
program.command("statistics").description("Summarize Theme, Revision, and Asset counts").action(async () => {
  const options = program.opts<CliOptions>();
  output(await request("/api/v2/statistics", options), options.json);
});
program.command("export").description("Export the current Vault projection as JSON").action(async () => {
  const options = program.opts<CliOptions>();
  output(await request("/api/v2/export", options), options.json);
});
const workspace = program.command("workspace").description("Inspect file-first workspace state");
workspace.command("synchronize").description("Scan Themes for unsaved Drafts and invalid workspaces").action(async () => {
  const options = program.opts<CliOptions>();
  output(await jsonRequest("/api/v2/workspace/synchronize", options, "POST"), options.json);
});

const auth = program.command("auth").description("Authenticate Vault Hosts");
auth.command("request")
  .description("Start browser authorization and return immediately")
  .option("--name <name>", "Local host name", "default")
  .option("--allow-insecure-http", "Allow credentials over remote HTTP")
  .action(async (commandOptions) => {
    const options = program.opts<CliOptions>();
    if (!options.host) throw new CliError("HOST_REQUIRED", "Pass --host with the Vault Host URL.", 2);
    const requested = await requestLogin(options.host, Boolean(commandOptions.allowInsecureHttp));
    output({ host: commandOptions.name, url: requested.url, ...requested.device }, options.json);
  });
auth.command("complete")
  .description("Complete a previously approved browser authorization")
  .requiredOption("--device-code <deviceCode>", "Secret device authorization code")
  .option("--name <name>", "Local host name", "default")
  .option("--allow-insecure-http", "Allow credentials over remote HTTP")
  .action(async (commandOptions) => {
    const options = program.opts<CliOptions>();
    if (!options.host) throw new CliError("HOST_REQUIRED", "Pass --host with the Vault Host URL.", 2);
    output(await completeLogin(options.host, commandOptions.name, commandOptions.deviceCode, Boolean(commandOptions.allowInsecureHttp)), options.json);
  });
auth.command("login")
  .option("--name <name>", "Local host name", "default")
  .option("--no-browser", "Print the approval URL without opening a browser")
  .option("--allow-insecure-http", "Allow credentials over remote HTTP")
  .action(async (commandOptions) => {
    const options = program.opts<CliOptions>();
    if (!options.host) throw new CliError("HOST_REQUIRED", "Pass --host with the Vault Host URL.", 2);
    output(await login(options.host, commandOptions.name, Boolean(commandOptions.browser === false), Boolean(commandOptions.allowInsecureHttp)), options.json);
  });
auth.command("status").action(async () => {
  const options = program.opts<CliOptions>();
  const connection = await resolveConnection(options.host);
  if (!connection) throw new CliError("HOST_REQUIRED", "No configured Vault Host was found.", 2);
  if (!connection.token) {
    output({ host: connection.name, url: connection.url, authenticated: false }, options.json);
    return;
  }
  const identity = await request("/api/v2/auth/session", { ...options, host: connection.name });
  output({ host: connection.name, url: connection.url, authenticated: true, identity }, options.json);
});
auth.command("logout").action(async () => {
  const options = program.opts<CliOptions>();
  const connection = await resolveConnection(options.host);
  if (!connection) throw new CliError("HOST_REQUIRED", "No configured Vault Host was found.", 2);
  if (connection.token) {
    assertSecureCredentialTransport(connection.url, connection.allowInsecureHttp);
    const response = await fetchHost(new URL("/api/v2/auth/session", connection.url), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!response.ok && response.status !== 401) throw new CliError("HOST_ERROR", `Could not revoke credential (${response.status})`);
  }
  await removeLogin(connection.name);
  output({ host: connection.name, authenticated: false }, options.json);
});

const host = program.command("host").description("Manage Vault Host connections");
host.command("list").action(async () => output(await listHosts(), program.opts<CliOptions>().json));
host.command("use").argument("<name>").action(async (name) => output(await useHost(name), program.opts<CliOptions>().json));

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && new Set(["commander.helpDisplayed", "commander.version"]).has(error.code)) process.exit(0);
  const cliError = error instanceof CliError
    ? error
    : error instanceof CommanderError
      ? new CliError("USAGE", parserMessage.trim() || error.message, 2)
      : new CliError("UNEXPECTED", error instanceof Error ? error.message : String(error));
  if (program.opts<CliOptions>().json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: cliError.code, message: cliError.message } })}\n`);
  } else {
    process.stderr.write(`${cliError.message}\n`);
  }
  process.exitCode = cliError.exitCode;
}
