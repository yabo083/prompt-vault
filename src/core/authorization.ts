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
  requestId: string;
  userCode: string;
  label: string;
  expiresAt: number;
  token?: string;
  approving?: boolean;
};

export class AuthorizationError extends Error {
  constructor(public readonly code: "TOO_MANY_REQUESTS", message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface AuthorizationStore {
  createDeviceRequest(input: { label: string; verificationOrigin: string }): Promise<{
    requestId: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }>;
  inspectDeviceRequest(requestId: string, userCode: string): Promise<Pick<DeviceRequest, "requestId" | "userCode" | "label" | "expiresAt"> | null>;
  pollDeviceRequest(requestId: string): Promise<{ status: "pending" } | { status: "approved"; token: string } | { status: "expired" } | null>;
  listPendingRequests(): Promise<Array<Pick<DeviceRequest, "requestId" | "userCode" | "label" | "expiresAt">>>;
  approveDeviceRequest(requestId: string, userCode: string): Promise<boolean>;
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
}: {
  credentialDirectory: string;
  now?: () => number;
  maxPending?: number;
}): Promise<AuthorizationStore> {
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  const pending = new Map<string, DeviceRequest>();

  function discardExpired() {
    for (const [id, request] of pending) {
      if (request.expiresAt <= now()) pending.delete(id);
    }
  }

  function inspect(requestId: string, userCode: string) {
    const request = pending.get(requestId);
    if (!request || request.expiresAt <= now() || !equalText(request.userCode, userCode.toUpperCase())) return null;
    return request;
  }

  return {
    async createDeviceRequest({ label, verificationOrigin }) {
      discardExpired();
      const awaitingApproval = [...pending.values()].filter((request) => !request.token).length;
      if (awaitingApproval >= maxPending) throw new AuthorizationError("TOO_MANY_REQUESTS", "Too many pending CLI authorization requests");
      const requestId = randomBytes(24).toString("base64url");
      const userCode = randomBytes(6).toString("base64url").replace(/[-_]/g, "A").slice(0, 8).toUpperCase();
      const expiresIn = 600;
      const normalizedLabel = label.trim().slice(0, 80) || "Prompt Vault CLI";
      pending.set(requestId, { requestId, userCode, label: normalizedLabel, expiresAt: now() + expiresIn * 1_000 });
      return {
        requestId,
        userCode,
        verificationUri: `${verificationOrigin.replace(/\/$/, "")}/auth/cli/${requestId}?code=${userCode}`,
        expiresIn,
        interval: 1,
      };
    },

    async inspectDeviceRequest(requestId, userCode) {
      const request = inspect(requestId, userCode);
      return request ? { requestId: request.requestId, userCode: request.userCode, label: request.label, expiresAt: request.expiresAt } : null;
    },

    async pollDeviceRequest(requestId) {
      const request = pending.get(requestId);
      if (!request) return null;
      if (request.expiresAt <= now()) {
        pending.delete(requestId);
        return { status: "expired" };
      }
      if (!request.token) return { status: "pending" };
      return { status: "approved", token: request.token };
    },

    async listPendingRequests() {
      discardExpired();
      return [...pending.values()].filter((request) => !request.token).map(({ requestId, userCode, label, expiresAt }) => ({ requestId, userCode, label, expiresAt }));
    },

    async approveDeviceRequest(requestId, userCode) {
      const request = inspect(requestId, userCode);
      if (!request || request.token || request.approving) return false;
      request.approving = true;
      const token = `pv_${randomBytes(32).toString("base64url")}`;
      const credential: Credential = {
        id: randomBytes(12).toString("base64url"),
        label: request.label,
        tokenHash: tokenHash(token),
        createdAt: new Date(now()).toISOString(),
      };
      try {
        await writeCredential(credentialDirectory, credential);
        request.token = token;
        return true;
      } finally {
        request.approving = false;
      }
    },

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
