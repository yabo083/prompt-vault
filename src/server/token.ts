import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function readToken(tokenFile: string) {
  try {
    return (await readFile(tokenFile, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function acquireLock(lockFile: string) {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      return await open(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lockFile)).mtimeMs > 10_000) {
          await unlink(lockFile);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Could not acquire token lock: ${lockFile}`);
}

export async function loadOrCreateHostToken({ tokenFile }: { tokenFile: string }) {
  const existing = await readToken(tokenFile);
  if (existing) return existing;
  await mkdir(dirname(tokenFile), { recursive: true });
  const lockFile = `${tokenFile}.lock`;
  const lock = await acquireLock(lockFile);
  try {
    const concurrent = await readToken(tokenFile);
    if (concurrent) return concurrent;
    const token = randomBytes(32).toString("base64url");
    await writeFile(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    return token;
  } finally {
    await lock.close();
    await unlink(lockFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
