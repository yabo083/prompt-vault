import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export type CliIdentity = {
  kind: "cli";
  id: string;
  label: string;
};

export type CredentialSummary = CliIdentity & { createdAt: string };

export type DeviceRequest = {
  id: string;
  userCode: string;
  label: string;
  expiresAt: number;
  approved?: boolean;
  exchanging?: boolean;
  denied?: boolean;
  nextPollAt?: number;
};

export class AuthorizationError extends Error {
  constructor(public readonly code: "TOO_MANY_REQUESTS", message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface AuthorizationStore {
  createDeviceRequest(input: { label: string; verificationOrigin: string }): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }>;
  inspectDeviceRequest(userCode: string): Promise<Pick<DeviceRequest, "id" | "userCode" | "label" | "expiresAt"> | null>;
  exchangeDeviceCode(deviceCode: string): Promise<{ status: "pending" } | { status: "slow_down"; interval: number } | { status: "approved"; token: string } | { status: "denied" } | { status: "expired" } | null>;
  discardDeviceRequest(deviceCode: string): Promise<boolean>;
  listPendingRequests(): Promise<Array<Pick<DeviceRequest, "id" | "userCode" | "label" | "expiresAt">>>;
  approveDeviceRequest(userCode: string): Promise<boolean>;
  denyDeviceRequest(userCode: string): Promise<boolean>;
  issueCredential(label: string): Promise<{ identity: CliIdentity; token: string }>;
  authenticate(token: string): Promise<CliIdentity | null>;
  listCredentials(): Promise<CredentialSummary[]>;
  revoke(token: string): Promise<boolean>;
  revokeById(id: string): Promise<boolean>;
}

const credentialSchema = z.object({
  id: z.string(),
  label: z.string(),
  tokenHash: z.string(),
  createdAt: z.string(),
});

type Credential = z.infer<typeof credentialSchema>;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function equalText(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readCredentials(directory: string): Promise<Array<Credential & { path: string }>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records: Array<Credential & { path: string }> = [];
  for (const name of (await readdir(directory)).filter((item) => item.endsWith(".json")).sort()) {
    const path = join(directory, name);
    records.push({ ...credentialSchema.parse(JSON.parse(await readFile(path, "utf8"))), path });
  }
  return records;
}

async function writeCredential(directory: string, credential: Credential) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${credential.id}.json`);
  const temporary = join(directory, `.${credential.id}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
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
}

export async function createAuthorizationStore({
  credentialDirectory,
  now = () => Date.now(),
  maxPending = 20,
  pollIntervalMs = 1_000,
}: {
  credentialDirectory: string;
  now?: () => number;
  maxPending?: number;
  pollIntervalMs?: number;
}): Promise<AuthorizationStore> {
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  const pending = new Map<string, DeviceRequest>();

  function discardExpired() {
    for (const [id, request] of pending) {
      if (request.expiresAt <= now()) pending.delete(id);
    }
  }

  function inspectUserCode(userCode: string) {
    const normalized = userCode.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    return [...pending.values()].find((request) => request.expiresAt > now() && equalText(request.userCode, normalized)) || null;
  }

  async function issueCredential(label: string) {
    const token = `pv_${randomBytes(32).toString("base64url")}`;
    const identity: CliIdentity = {
      kind: "cli",
      id: randomBytes(12).toString("base64url"),
      label: label.trim().slice(0, 80) || "Prompt Vault CLI",
    };
    await writeCredential(credentialDirectory, {
      id: identity.id,
      label: identity.label,
      tokenHash: tokenHash(token),
      createdAt: new Date(now()).toISOString(),
    });
    return { identity, token };
  }

  return {
    async createDeviceRequest({ label, verificationOrigin }) {
      discardExpired();
      const awaitingApproval = [...pending.values()].filter((request) => !request.approved && !request.denied).length;
      if (awaitingApproval >= maxPending) throw new AuthorizationError("TOO_MANY_REQUESTS", "Too many pending CLI authorization requests");
      const id = randomBytes(12).toString("base64url");
      const deviceCode = randomBytes(32).toString("base64url");
      let userCode = "";
      do {
        userCode = randomBytes(6).toString("base64url").replace(/[-_]/g, "A").slice(0, 8).toUpperCase();
      } while (inspectUserCode(userCode));
      const expiresIn = 600;
      const normalizedLabel = label.trim().slice(0, 80) || "Prompt Vault CLI";
      pending.set(tokenHash(deviceCode), { id, userCode, label: normalizedLabel, expiresAt: now() + expiresIn * 1_000 });
      return {
        deviceCode,
        userCode,
        verificationUri: `${verificationOrigin.replace(/\/$/, "")}/auth/cli?code=${userCode}`,
        expiresIn,
        interval: pollIntervalMs / 1_000,
      };
    },

    async inspectDeviceRequest(userCode) {
      const request = inspectUserCode(userCode);
      return request ? { id: request.id, userCode: request.userCode, label: request.label, expiresAt: request.expiresAt } : null;
    },

    async exchangeDeviceCode(deviceCode) {
      const key = tokenHash(deviceCode);
      const request = pending.get(key);
      if (!request) return null;
      if (request.expiresAt <= now()) {
        pending.delete(key);
        return { status: "expired" };
      }
      if (request.nextPollAt !== undefined && request.nextPollAt > now()) return { status: "slow_down", interval: pollIntervalMs / 1_000 };
      request.nextPollAt = now() + pollIntervalMs;
      if (request.denied) {
        pending.delete(key);
        return { status: "denied" };
      }
      if (!request.approved) return { status: "pending" };
      if (request.exchanging) return { status: "slow_down", interval: pollIntervalMs / 1_000 };
      request.exchanging = true;
      try {
        const credential = await issueCredential(request.label);
        pending.delete(key);
        return { status: "approved", token: credential.token };
      } finally {
        request.exchanging = false;
      }
    },

    async discardDeviceRequest(deviceCode: string) {
      return pending.delete(tokenHash(deviceCode));
    },

    async listPendingRequests() {
      discardExpired();
      return [...pending.values()].filter((request) => !request.approved && !request.denied).map(({ id, userCode, label, expiresAt }) => ({ id, userCode, label, expiresAt }));
    },

    async approveDeviceRequest(userCode) {
      const request = inspectUserCode(userCode);
      if (!request || request.approved || request.denied) return false;
      request.approved = true;
      return true;
    },

    async denyDeviceRequest(userCode) {
      const request = inspectUserCode(userCode);
      if (!request || request.approved || request.denied) return false;
      request.denied = true;
      return true;
    },

    issueCredential,

    async authenticate(token) {
      if (!token) return null;
      const hash = tokenHash(token);
      const credential = (await readCredentials(credentialDirectory)).find((item) => equalText(item.tokenHash, hash));
      return credential ? { kind: "cli", id: credential.id, label: credential.label } : null;
    },

    async listCredentials() {
      return (await readCredentials(credentialDirectory)).map(({ id, label, createdAt }) => ({ kind: "cli", id, label, createdAt }));
    },

    async revoke(token) {
      const hash = tokenHash(token);
      const credential = (await readCredentials(credentialDirectory)).find((item) => equalText(item.tokenHash, hash));
      if (!credential) return false;
      await unlink(credential.path);
      return true;
    },

    async revokeById(id) {
      const credential = (await readCredentials(credentialDirectory)).find((item) => item.id === id);
      if (!credential) return false;
      await unlink(credential.path);
      return true;
    },
  };
}
