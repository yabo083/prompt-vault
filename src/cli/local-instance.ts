import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { setDefaultLocalInstance } from "./config.js";
import { CliError } from "./errors.js";

const instanceSchema = z.object({
  format: z.literal("prompt-vault/instance/v1"),
  id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  bind: z.string(),
  port: z.number().int().min(1).max(65_535),
  publicOrigin: z.string().url(),
  createdAt: z.string().datetime(),
});

export type LocalInstance = z.infer<typeof instanceSchema>;
export const defaultInstanceDirectory = join(homedir(), "PromptVault");

export function expandInstanceDirectory(path: string) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function instancePaths(directory: string) {
  const root = expandInstanceDirectory(directory);
  const state = join(root, ".prompt-vault");
  return {
    root,
    state,
    descriptor: join(state, "instance.json"),
    workspace: join(root, "workspace"),
    token: join(state, ".vault-token"),
    authorization: join(state, ".vault-auth"),
    browserSessions: join(state, ".browser-sessions"),
  };
}

export function isLiteralLoopback(hostname: string) {
  const candidate = hostname.replace(/^\[|\]$/g, "");
  if (candidate === "::1") return true;
  const parts = candidate.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function supportsAutomaticLocalAuthorization(instance: LocalInstance) {
  return isLiteralLoopback(instance.bind) && isLiteralLoopback(new URL(instance.publicOrigin).hostname);
}

export function localListenerOrigin(bind: string, port: number) {
  const host = bind.includes(":") ? `[${bind}]` : bind;
  return `http://${host}:${port}`;
}

function validatePublicOrigin(value: string, bind: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("INVALID_PUBLIC_URL", "Public URL must be a valid http or https origin", 2);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new CliError("INVALID_PUBLIC_URL", "Public URL must be an http or https origin without credentials, a path, query, or fragment", 2);
  }
  if (!isLiteralLoopback(bind) && url.protocol !== "https:") {
    throw new CliError("INSECURE_PUBLIC_URL", "Non-loopback listeners require an HTTPS public URL", 2);
  }
  return url.origin;
}

async function atomicFile(path: string, contents: string, mode: number) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, mode);
}

async function readDescriptor(path: string) {
  try {
    return instanceSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new CliError("INVALID_INSTANCE", `Managed instance configuration is invalid: ${path}`, 2);
    throw error;
  }
}

export async function readLocalInstance(directory: string) {
  const paths = instancePaths(directory);
  const instance = await readDescriptor(paths.descriptor);
  if (!instance) throw new CliError("INSTANCE_NOT_INITIALIZED", `No managed Prompt Vault instance was found at ${paths.root}`, 2);
  return { instance, paths };
}

export async function initializeLocalInstance({
  directory,
  bind,
  port,
  publicUrl,
}: {
  directory: string;
  bind: string;
  port: number;
  publicUrl?: string;
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new CliError("INVALID_PORT", "Port must be an integer between 1 and 65535", 2);
  if (!bind || /[\r\n\s]/.test(bind)) throw new CliError("INVALID_BIND", "Bind address must not be empty or contain whitespace", 2);
  const paths = instancePaths(directory);
  const existing = await readDescriptor(paths.descriptor);
  if (existing) {
    await setDefaultLocalInstance(paths.root);
    return { state: "initialized" as const, directory: paths.root, url: existing.publicOrigin };
  }

  await mkdir(paths.root, { recursive: true });
  const release = await lockfile.lock(paths.root, {
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 120, factor: 1.2, minTimeout: 10, maxTimeout: 250 },
  });
  try {
    const concurrent = await readDescriptor(paths.descriptor);
    if (concurrent) {
      await setDefaultLocalInstance(paths.root);
      return { state: "initialized" as const, directory: paths.root, url: concurrent.publicOrigin };
    }
    const entries = await readdir(paths.root);
    if (entries.length) throw new CliError("INSTANCE_DIRECTORY_CONFLICT", `Refusing to initialize non-empty unmanaged directory: ${paths.root}`, 2);
    const publicOrigin = validatePublicOrigin(publicUrl || localListenerOrigin(bind, port), bind);
    const instance: LocalInstance = {
      format: "prompt-vault/instance/v1",
      id: randomBytes(16).toString("base64url"),
      bind,
      port,
      publicOrigin,
      createdAt: new Date().toISOString(),
    };
    const stagingRoot = `${paths.root}.init-${randomBytes(8).toString("hex")}`;
    const staging = instancePaths(stagingRoot);
    try {
      await Promise.all([
        mkdir(staging.workspace, { recursive: true }),
        mkdir(staging.authorization, { recursive: true, mode: 0o700 }),
        mkdir(staging.browserSessions, { recursive: true, mode: 0o700 }),
      ]);
      await atomicFile(staging.descriptor, `${JSON.stringify(instance, null, 2)}\n`, 0o600);
      await rmdir(paths.root);
      await rename(staging.root, paths.root);
    } catch (error) {
      await rm(staging.root, { recursive: true, force: true });
      throw error;
    }
    await setDefaultLocalInstance(paths.root);
    return { state: "initialized" as const, directory: paths.root, url: instance.publicOrigin };
  } finally {
    await release();
  }
}
