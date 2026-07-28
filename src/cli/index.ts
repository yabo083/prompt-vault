#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, resolve as resolvePath } from "node:path";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { listHosts, removeLogin, resolveConnection, saveLogin, useHost } from "./config.js";
import { VERSION } from "./version.js";

type CliOptions = { host?: string; json?: boolean };

class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
  }
}

const deviceResponseSchema = z.object({
  requestId: z.string().min(16),
  userCode: z.string().regex(/^[A-Z0-9]{8}$/),
  verificationUri: z.string().url(),
  expiresIn: z.number().positive().max(3_600),
  interval: z.number().nonnegative().max(30),
});

const approvedResponseSchema = z.object({ status: z.literal("approved"), token: z.string().startsWith("pv_") });

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
  const [command, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.once("error", () => resolve(false));
  });
}

function parseHost(host: string) {
  let hostUrl: URL;
  try {
    hostUrl = new URL(host);
  } catch {
    throw new CliError("INVALID_HOST", "Vault Host must be a valid http or https URL", 2);
  }
  if (!new Set(["http:", "https:"]).has(hostUrl.protocol)) throw new CliError("INVALID_HOST", "Vault Host must use http or https", 2);
  const url = hostUrl.toString().replace(/\/$/, "");
  return { hostUrl, url };
}

async function requestLogin(host: string) {
  const { hostUrl, url } = parseHost(host);
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

async function saveApprovedLogin(name: string, url: string, token: string) {
  try {
    const existing = await resolveConnection(name);
    const saved = await saveLogin(name, url, token);
    if (existing?.token && existing.token !== token) {
      try {
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
    const revoked = await fetchHost(new URL("/api/v2/auth/session", url), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => response.ok || response.status === 401)
      .catch(() => false);
    const message = error instanceof Error ? error.message : "Credential storage failed";
    if (!revoked) {
      throw new CliError("AUTH_RECOVERY_REQUIRED", `${message}. The Vault Host credential could not be revoked; retry auth complete with the same request.`, 4);
    }
    throw new CliError("CREDENTIAL_SAVE_FAILED_REVOKED", `${message}. The unused Vault Host credential was revoked.`, 4);
  }
}

async function discardLoginRequest(url: string, requestId: string) {
  const response = await fetchHost(new URL(`/api/v2/auth/device/${encodeURIComponent(requestId)}`, url), { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new CliError("AUTH_CONFIRM_FAILED", `Credential was saved, but the Vault Host could not confirm authorization completion (${response.status}). Retry auth complete with the same request.`, 4);
  }
}

async function completeLogin(host: string, name: string, requestId: string) {
  const { url } = parseHost(host);
  const response = await fetchHost(new URL(`/api/v2/auth/device/${encodeURIComponent(requestId)}`, url));
  if (response.status === 202) return { status: "pending" as const, host: name, url };
  if (response.status === 410) throw new CliError("AUTH_EXPIRED", "Authorization request expired", 4);
  if (response.status !== 200) throw new CliError("AUTH_FAILED", `Authorization failed (${response.status})`, 4);
  const parsedApproval = approvedResponseSchema.safeParse(await jsonPayload(response));
  if (!parsedApproval.success) throw new CliError("INVALID_HOST_RESPONSE", "Vault Host returned an invalid credential", 3);
  try {
    const saved = await saveApprovedLogin(name, url, parsedApproval.data.token);
    await discardLoginRequest(url, requestId);
    return { status: "approved" as const, ...saved };
  } catch (error) {
    if (error instanceof CliError && error.code === "CREDENTIAL_SAVE_FAILED_REVOKED") {
      await discardLoginRequest(url, requestId).catch(() => undefined);
    }
    throw error;
  }
}

async function login(host: string, name: string, noBrowser = false) {
  const { url, device } = await requestLogin(host);
  const verificationUrl = new URL(device.verificationUri);
  process.stderr.write(`Open ${verificationUrl.toString()}\nCode: ${device.userCode}\n`);
  if (!(await openBrowser(verificationUrl.toString(), noBrowser))) process.stderr.write("Browser could not be opened; use the URL above.\n");
  const deadline = Date.now() + device.expiresIn * 1_000;
  while (Date.now() < deadline) {
    const completed = await completeLogin(url, name, device.requestId);
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
      return { version: VERSION, configured: true as const, currentHost: null, authenticated: false as const, hosts: hosts.map((host) => host.name) };
    }
    return { version: VERSION, configured: false as const, currentHost: null, authenticated: false as const };
  }
  if (!connection.token) {
    return { version: VERSION, configured: true as const, currentHost: connection.name, url: connection.url, authenticated: false as const };
  }
  try {
    const identity = await request("/api/v2/auth/session", { host: connection.name });
    return { version: VERSION, configured: true as const, currentHost: connection.name, url: connection.url, authenticated: true as const, identity };
  } catch (error) {
    if (error instanceof CliError && error.code === "UNAUTHORIZED") {
      return { version: VERSION, configured: true as const, currentHost: connection.name, url: connection.url, authenticated: false as const };
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
  .action(async (url, commandOptions) => {
    output(await login(url, commandOptions.name, Boolean(commandOptions.browser === false)), program.opts<CliOptions>().json);
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
  .action(async (commandOptions) => {
    const options = program.opts<CliOptions>();
    if (!options.host) throw new CliError("HOST_REQUIRED", "Pass --host with the Vault Host URL.", 2);
    const requested = await requestLogin(options.host);
    output({ host: commandOptions.name, url: requested.url, ...requested.device }, options.json);
  });
auth.command("complete")
  .description("Complete a previously approved browser authorization")
  .requiredOption("--request <requestId>", "Authorization request ID")
  .option("--name <name>", "Local host name", "default")
  .action(async (commandOptions) => {
    const options = program.opts<CliOptions>();
    if (!options.host) throw new CliError("HOST_REQUIRED", "Pass --host with the Vault Host URL.", 2);
    output(await completeLogin(options.host, commandOptions.name, commandOptions.request), options.json);
  });
auth.command("login")
  .option("--name <name>", "Local host name", "default")
  .option("--no-browser", "Print the approval URL without opening a browser")
  .action(async (commandOptions) => {
    const options = program.opts<CliOptions>();
    if (!options.host) throw new CliError("HOST_REQUIRED", "Pass --host with the Vault Host URL.", 2);
    output(await login(options.host, commandOptions.name, Boolean(commandOptions.browser === false)), options.json);
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
