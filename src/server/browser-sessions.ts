import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const sessionSchema = z.object({
  id: z.string(),
  tokenHash: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

type Session = z.infer<typeof sessionSchema>;

export interface BrowserSessionStore {
  create(): Promise<{ token: string; expiresAt: Date }>;
  authenticate(token: string): Promise<boolean>;
  revoke(token: string): Promise<boolean>;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function equalText(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createMemoryBrowserSessionStore({ now = () => Date.now(), lifetimeMs = 30 * 24 * 60 * 60 * 1_000 } = {}): BrowserSessionStore {
  const sessions = new Map<string, number>();
  return {
    async create() {
      const token = `pvs_${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(now() + lifetimeMs);
      sessions.set(hashToken(token), expiresAt.getTime());
      return { token, expiresAt };
    },
    async authenticate(token) {
      const hash = hashToken(token);
      const expiresAt = sessions.get(hash);
      if (!expiresAt || expiresAt <= now()) {
        sessions.delete(hash);
        return false;
      }
      return true;
    },
    async revoke(token) {
      return sessions.delete(hashToken(token));
    },
  };
}

export function createBrowserSessionStore({
  directory,
  now = () => Date.now(),
  lifetimeMs = 30 * 24 * 60 * 60 * 1_000,
}: {
  directory: string;
  now?: () => number;
  lifetimeMs?: number;
}): BrowserSessionStore {
  async function readSessions() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sessions: Array<Session & { path: string }> = [];
    for (const name of (await readdir(directory)).filter((item) => item.endsWith(".json"))) {
      const path = join(directory, name);
      sessions.push({ ...sessionSchema.parse(JSON.parse(await readFile(path, "utf8"))), path });
    }
    return sessions;
  }

  async function find(token: string) {
    if (!token) return null;
    const hash = hashToken(token);
    return (await readSessions()).find((session) => equalText(session.tokenHash, hash)) || null;
  }

  return {
    async create() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const token = `pvs_${randomBytes(32).toString("base64url")}`;
      const createdAt = new Date(now());
      const expiresAt = new Date(createdAt.getTime() + lifetimeMs);
      const session: Session = {
        id: randomBytes(16).toString("base64url"),
        tokenHash: hashToken(token),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      const path = join(directory, `${session.id}.json`);
      const temporary = join(directory, `.${session.id}.${randomBytes(8).toString("hex")}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(session, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return { token, expiresAt };
    },
    async authenticate(token) {
      const session = await find(token);
      if (!session) return false;
      if (Date.parse(session.expiresAt) <= now()) {
        await unlink(session.path).catch(() => undefined);
        return false;
      }
      return true;
    },
    async revoke(token) {
      const session = await find(token);
      if (!session) return false;
      await unlink(session.path);
      return true;
    },
  };
}
