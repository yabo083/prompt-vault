import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";

const hostSchema = z.object({
  url: z.string().url(),
  allowInsecureHttp: z.boolean(),
  ownership: z.enum(["managed-local", "external"]),
});

const configSchema = z.object({
  currentHost: z.string().nullable(),
  localInstance: z.string().nullable(),
  hosts: z.record(z.string(), hostSchema),
});

const fileCredentialsSchema = z.object({
  tokens: z.record(z.string(), z.string()),
});

type CliConfig = z.infer<typeof configSchema>;

function configDirectory() {
  if (process.env.PROMPT_VAULT_CONFIG_DIR) return process.env.PROMPT_VAULT_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "prompt-vault");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "prompt-vault");
}

async function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown, mode?: number) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temporary, path);
  if (mode && process.platform !== "win32") await chmod(path, mode);
}

function normalizeHostUrl(value: string) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Vault Host URL must use http or https");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateHostName(name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error("Vault Host name must contain only letters, numbers, dots, underscores, or hyphens");
  return name;
}

function paths() {
  const directory = configDirectory();
  return { directory, config: join(directory, "config.json"), credentials: join(directory, "credentials.json") };
}

async function withConfigLock<T>(operation: () => Promise<T>) {
  const directory = paths().directory;
  await mkdir(directory, { recursive: true });
  const release = await lockfile.lock(directory, {
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 120, factor: 1.2, minTimeout: 10, maxTimeout: 250 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function useFileCredentialStore() {
  return process.env.PROMPT_VAULT_CREDENTIAL_STORE === "file" || process.platform === "linux";
}

function keyringService(directory: string) {
  return `prompt-vault-cli-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`;
}

async function readFileCredentials(path: string) {
  return readJson(path, fileCredentialsSchema, { tokens: {} });
}

async function keyringEntry(directory: string, name: string) {
  if (useFileCredentialStore()) return null;
  try {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(keyringService(directory), name);
  } catch {
    return null;
  }
}

async function getToken(name: string) {
  const files = paths();
  const fileToken = (await readFileCredentials(files.credentials)).tokens[name];
  if (fileToken) return fileToken;
  const entry = await keyringEntry(files.directory, name);
  if (!entry) return undefined;
  try {
    return entry.getPassword() || undefined;
  } catch {
    return undefined;
  }
}

async function setToken(name: string, token: string) {
  const files = paths();
  const entry = await keyringEntry(files.directory, name);
  if (entry) {
    try {
      entry.setPassword(token);
      const credentials = await readFileCredentials(files.credentials);
      if (credentials.tokens[name]) {
        const tokens = { ...credentials.tokens };
        delete tokens[name];
        await atomicJson(files.credentials, { tokens }, 0o600);
      }
      return;
    } catch {
      // Fall back to the protected file store when the platform service is unavailable.
    }
  }
  const credentials = await readFileCredentials(files.credentials);
  await atomicJson(files.credentials, { tokens: { ...credentials.tokens, [name]: token } }, 0o600);
}

async function deleteToken(name: string) {
  const files = paths();
  const entry = await keyringEntry(files.directory, name);
  if (entry) {
    try {
      entry.deletePassword();
    } catch {
      // Continue so a file-fallback credential is still removed.
    }
  }
  const credentials = await readFileCredentials(files.credentials);
  const tokens = { ...credentials.tokens };
  delete tokens[name];
  await atomicJson(files.credentials, { tokens }, 0o600);
}

async function loadConfig() {
  const files = paths();
  return { files, config: await readJson(files.config, configSchema, { currentHost: null, localInstance: null, hosts: {} }) };
}

export async function setDefaultLocalInstance(directory: string) {
  return withConfigLock(async () => {
    const { files, config } = await loadConfig();
    await atomicJson(files.config, { ...config, localInstance: directory });
    return directory;
  });
}

export async function getDefaultLocalInstance() {
  return (await loadConfig()).config.localInstance;
}

export async function saveLogin(nameValue: string, url: string, token: string, {
  select = true,
  allowInsecureHttp = false,
  ownership = "external",
}: {
  select?: boolean;
  allowInsecureHttp?: boolean;
  ownership?: "managed-local" | "external";
} = {}) {
  const name = validateHostName(nameValue);
  return withConfigLock(async () => {
    const { files, config } = await loadConfig();
    const normalized = normalizeHostUrl(url);
    const previousToken = await getToken(name);
    await setToken(name, token);
    const nextConfig: CliConfig = {
      ...config,
      currentHost: select ? name : config.currentHost,
      hosts: { ...config.hosts, [name]: { url: normalized, allowInsecureHttp, ownership } },
    };
    try {
      await atomicJson(files.config, nextConfig);
    } catch (error) {
      if (previousToken) await setToken(name, previousToken);
      else await deleteToken(name);
      throw error;
    }
    return { name, url: normalized };
  });
}

export async function removeLogin(nameValue: string) {
  const name = validateHostName(nameValue);
  await withConfigLock(async () => {
    const { files, config } = await loadConfig();
    await deleteToken(name);
    if (config.currentHost === name) await atomicJson(files.config, { ...config, currentHost: null });
  });
}

export async function resolveConnection(selector?: string) {
  const { config } = await loadConfig();
  if (selector && /^https?:\/\//i.test(selector)) {
    const url = normalizeHostUrl(selector);
    const configured = Object.entries(config.hosts).find(([, host]) => host.url === url)?.[0];
    const host = configured ? config.hosts[configured] : null;
    return {
      name: configured || url,
      url,
      token: configured ? await getToken(configured) : undefined,
      allowInsecureHttp: host?.allowInsecureHttp || false,
      ownership: host?.ownership || ("external" as const),
    };
  }
  const name = selector || config.currentHost;
  if (!name || !config.hosts[name]) return null;
  return { name, ...config.hosts[name], token: await getToken(name) };
}

export async function listHosts() {
  const { config } = await loadConfig();
  const hosts = await Promise.all(Object.entries(config.hosts).map(async ([name, host]) => ({
    name,
    url: host.url,
    current: config.currentHost === name,
    authenticated: Boolean(await getToken(name)),
    ownership: host.ownership,
    allowInsecureHttp: host.allowInsecureHttp,
  })));
  return hosts.sort((left, right) => left.name.localeCompare(right.name));
}

export async function useHost(nameValue: string) {
  const name = validateHostName(nameValue);
  return withConfigLock(async () => {
    const { files, config } = await loadConfig();
    if (!config.hosts[name]) throw new Error(`Unknown Vault Host: ${name}`);
    await atomicJson(files.config, { ...config, currentHost: name });
    return { name, url: config.hosts[name].url };
  });
}
