import { randomBytes, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { isIP } from "node:net";
import { join } from "node:path";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z, ZodError } from "zod";
import { AuthorizationError, type AuthorizationStore, type CliIdentity } from "../core/authorization.js";
import type { ApplyDraftEditInput, AssetKind, PromptVault } from "../core/types.js";
import { VaultError } from "../core/types.js";
import { createMemoryBrowserSessionStore, type BrowserSessionStore } from "./browser-sessions.js";
import type { LocalLaunchAuthorization } from "./local-launch.js";

type HostIdentity = { kind: "host"; label: "Vault Host" };
type Identity = HostIdentity | CliIdentity;

class HttpError extends Error {
  constructor(public readonly status: 400 | 413, public readonly code: string, message: string) {
    super(message);
  }
}

function equalToken(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sameOrigin(candidate: string | undefined, expected: string) {
  if (!candidate) return false;
  try {
    return new URL(candidate).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function assetResponse(asset: { name: string; mime: string; content: Uint8Array }, immutable = false) {
  return new Response(Buffer.from(asset.content), {
    headers: {
      "Content-Type": asset.mime,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
      "Cache-Control": immutable ? "private, max-age=31536000, immutable" : "private, no-cache",
    },
  });
}

function staticCacheControl(path: string) {
  const filename = path.split("/").at(-1) || "";
  return /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(filename)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

async function limitedBody(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function limitedJson<T>(request: Request, maxBytes = 1_024): Promise<T> {
  const text = (await limitedBody(request, maxBytes)).toString("utf8");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function limitedFormData(request: Request, maxBytes = 64 * 1024 * 1024) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must use multipart/form-data");
  }
  try {
    return await new Response(await limitedBody(request, maxBytes), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_REQUEST", "Request body must contain valid multipart form data");
  }
}

const metadataFields = {
  description: z.string().max(20_000).optional(),
  category: z.string().max(200).optional(),
  tags: z.array(z.string().max(200)).max(100).optional(),
  starred: z.boolean().optional(),
  archived: z.boolean().optional(),
  prompt: z.string().max(1_000_000).optional(),
  negative: z.string().max(1_000_000).optional(),
  notes: z.string().max(1_000_000).optional(),
  model: z.string().max(1_000).optional(),
  params: z.string().max(100_000).optional(),
  referenceUrls: z.array(z.string().max(10_000).refine((value) => {
    try {
      return new Set(["http:", "https:"]).has(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Reference URLs must use HTTP or HTTPS")).max(100).optional(),
};
const themeInputSchema = z.object({ title: z.string().min(1).max(200), ...metadataFields }).strict();
const draftUpdateSchema = z.object({ title: z.string().min(1).max(200).optional(), ...metadataFields }).strict();
const assetKindSchema = z.enum(["reference", "result"]);
const assetOrderInputSchema = z.object({ names: z.array(z.string().min(1).max(255)).max(10_000) }).strict();
const assetOrderEntrySchema = z.object({ source: z.enum(["existing", "upload"]), index: z.number().int().nonnegative() }).strict();
const deviceRequestInputSchema = z.object({ label: z.string().max(200).optional() }).strict();
const deviceApprovalInputSchema = z.object({ userCode: z.string() }).strict();
const deviceTokenInputSchema = z.object({ deviceCode: z.string().min(32).max(200) }).strict();
const browserLoginInputSchema = z.object({ token: z.string().min(1).max(10_000) }).strict();
const localLaunchInputSchema = z.object({ nonce: z.string().min(32).max(200) }).strict();
const saveRevisionInputSchema = z.object({
  note: z.string().max(20_000).optional(),
  parentIds: z.array(z.number().int().positive()).max(100).optional(),
}).strict();
const replaceDraftInputSchema = z.object({ force: z.boolean().optional() }).strict();
const applyDraftEditSchema = z.object({
  sourceRevisionId: z.number().int().positive().optional(),
  force: z.boolean().optional(),
  nodeTitle: z.string().trim().min(1).max(20_000).optional(),
  update: z.object({
    prompt: z.string().max(1_000_000).optional(),
    negative: z.string().max(1_000_000).optional(),
    notes: z.string().max(1_000_000).optional(),
    model: z.string().max(1_000).optional(),
    params: z.string().max(100_000).optional(),
  }).strict().optional(),
  assets: z.object({
    reference: z.object({ remove: z.array(z.string().min(1).max(255)).optional(), order: z.array(assetOrderEntrySchema).optional() }).strict().optional(),
    result: z.object({ remove: z.array(z.string().min(1).max(255)).optional(), order: z.array(assetOrderEntrySchema).optional() }).strict().optional(),
  }).strict().optional(),
  saveRevision: z.object({ note: z.string().max(20_000).optional(), parentIds: z.array(z.number().int().positive()).max(100).optional() }).strict().optional(),
}).strict();
const overwriteRevisionEditSchema = applyDraftEditSchema
  .omit({ sourceRevisionId: true, force: true, nodeTitle: true, saveRevision: true })
  .extend({ note: z.string().max(20_000).optional() })
  .strict();
const revisionMarksSchema = z.object({
  featured: z.boolean().optional(),
  favorite: z.boolean().optional(),
  hidden: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Pass at least one Revision mark");
const nodeTitleSchema = z.object({ title: z.string().trim().min(1).max(20_000) }).strict();
const forceQuerySchema = z.enum(["true", "false"]).optional().transform((value) => value === "true");
const revisionIdSchema = z.coerce.number().int().positive();

export function createHttpApp({
  vault,
  token = "",
  authorization,
  browserSessions = createMemoryBrowserSessionStore(),
  localLaunch,
  instanceId,
  version,
  publicOrigin,
  trustedProxies = [],
  staticDirectory,
}: {
  vault: PromptVault;
  token?: string;
  authorization?: AuthorizationStore;
  browserSessions?: BrowserSessionStore;
  localLaunch?: LocalLaunchAuthorization;
  instanceId?: string;
  version?: string;
  publicOrigin?: string;
  trustedProxies?: string[];
  staticDirectory?: string;
}) {
  if (!token && !authorization) throw new Error("Prompt Vault authentication must be configured");
  const app = new Hono<{ Variables: { identity: Identity } }>();
  const deviceAttempts = new Map<string, number[]>();

  app.get("/healthz", (context) => context.json({
    status: "ok",
    ...(instanceId ? { instanceId } : {}),
    ...(version ? { version } : {}),
  }));

  app.use("/api/v2/*", async (context, next) => {
    const path = context.req.path;
    const publicDeviceRequest = path === "/api/v2/auth/device" && context.req.method === "POST";
    const publicDeviceToken = path === "/api/v2/auth/device/token" && new Set(["POST", "DELETE"]).has(context.req.method);
    const publicBrowserLogin = path === "/api/v2/auth/browser" && context.req.method === "POST";
    const publicLocalLaunch = path === "/api/v2/auth/launch" && context.req.method === "POST";
    if (publicDeviceRequest || publicDeviceToken || publicBrowserLogin || publicLocalLaunch) return next();
    if (token || authorization) {
       const authorizationHeader = context.req.header("Authorization") || "";
       const cookieSession = getCookie(context, "prompt_vault_session") || "";
       const supplied = authorizationHeader.startsWith("Bearer ") ? authorizationHeader.slice(7) : "";
       const usesCookie = Boolean(cookieSession && !authorizationHeader);
       if (usesCookie && !new Set(["GET", "HEAD", "OPTIONS"]).has(context.req.method)) {
         const origin = context.req.header("Origin");
         const fetchSite = context.req.header("Sec-Fetch-Site");
         if (!sameOrigin(origin, publicOrigin || context.req.url) || (fetchSite && !new Set(["same-origin", "none"]).has(fetchSite))) {
           return context.json({ error: { code: "FORBIDDEN", message: "Cookie-authenticated mutations require a same-origin request" } }, 403);
         }
       }
       if (usesCookie && await browserSessions.authenticate(cookieSession)) {
          context.set("identity", { kind: "host", label: "Vault Host" });
        }
       else {
        const identity = await authorization?.authenticate(supplied);
        if (!identity) return context.json({ error: { code: "UNAUTHORIZED", message: "A valid Vault Host credential is required" } }, 401);
        context.set("identity", identity);
      }
    }
    await next();
  });

  app.post("/api/v2/auth/launch", async (context) => {
    if (!localLaunch || !instanceId) return context.json({ error: { code: "NOT_FOUND", message: "Local browser launch is not available" } }, 404);
    const origin = context.req.header("Origin");
    if (!sameOrigin(origin, publicOrigin || context.req.url) || context.req.header("Sec-Fetch-Site") === "cross-site") {
      return context.json({ error: { code: "FORBIDDEN", message: "Local browser launch requires a same-origin request" } }, 403);
    }
    const input = localLaunchInputSchema.parse(await limitedJson(context.req.raw, 1_024));
    const result = localLaunch.claim({ nonce: input.nonce, origin: new URL(origin!).origin, instanceId });
    context.header("Cache-Control", "no-store");
    if (result === "expired") return context.json({ error: { code: "LAUNCH_EXPIRED", message: "The local browser launch link expired" } }, 410);
    if (result !== "claimed") return context.json({ error: { code: "UNAUTHORIZED", message: "The local browser launch link is invalid" } }, 401);
    const session = await browserSessions.create();
    setCookie(context, "prompt_vault_session", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: new URL(publicOrigin || context.req.url).protocol === "https:",
      path: "/",
      maxAge: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000)),
    });
    return context.body(null, 204);
  });

  app.post("/api/v2/auth/browser", async (context) => {
    if (!token) return context.json({ error: { code: "NOT_SUPPORTED", message: "Browser token authentication is not configured" } }, 501);
    const origin = context.req.header("Origin");
    const fetchSite = context.req.header("Sec-Fetch-Site");
    if (!sameOrigin(origin, publicOrigin || context.req.url) || (fetchSite && !new Set(["same-origin", "none"]).has(fetchSite))) {
      return context.json({ error: { code: "FORBIDDEN", message: "Browser authentication requires a same-origin request" } }, 403);
    }
    const input = browserLoginInputSchema.parse(await limitedJson(context.req.raw, 12 * 1024));
    if (!equalToken(input.token, token)) return context.json({ error: { code: "UNAUTHORIZED", message: "The Vault Host token is invalid" } }, 401);
    const canonicalOrigin = new URL(publicOrigin || context.req.url);
    const session = await browserSessions.create();
    setCookie(context, "prompt_vault_session", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: canonicalOrigin.protocol === "https:",
      path: "/",
      maxAge: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000)),
    });
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });

  app.delete("/api/v2/auth/browser", async (context) => {
    if (context.get("identity")?.kind !== "host") return context.json({ error: { code: "FORBIDDEN", message: "Vault Host authorization is required" } }, 403);
    const session = getCookie(context, "prompt_vault_session") || "";
    if (session) await browserSessions.revoke(session);
    deleteCookie(context, "prompt_vault_session", { path: "/", secure: new URL(publicOrigin || context.req.url).protocol === "https:" });
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });

  app.get("/auth/cli", async (context) => {
    const userCode = (context.req.query("code") || "").replace(/[^A-Z0-9]/g, "");
    const device = await authorization?.inspectDeviceRequest(userCode);
    if (!device) return context.html("<!doctype html><title>Authorization request not found</title><h1>Authorization request not found</h1>", 404);
    const nonce = randomBytes(18).toString("base64");
    context.header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    context.header("X-Frame-Options", "DENY");
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    return context.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Prompt Vault CLI</title><style>body{font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem}button{padding:.65rem 1rem}button+button{margin-left:.5rem}</style></head><body><main><h1>Authorize Prompt Vault CLI</h1><p>Application: <strong>${escapeHtml(device.label)}</strong></p><p>Code: <strong>${device.userCode}</strong></p><button id="approve">Approve</button><button id="deny">Deny</button><p id="status" role="status"></p></main><script nonce="${nonce}">const decide=async(action)=>{const response=await fetch('/api/v2/auth/device/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userCode:'${device.userCode}'})});document.getElementById('status').textContent=response.ok?(action==='approve'?'Authorized. You may close this tab.':'Denied. You may close this tab.'):'Authorization failed. Sign in to the Vault Host first.';};document.getElementById('approve').onclick=()=>decide('approve');document.getElementById('deny').onclick=()=>decide('deny');</script></body></html>`);
  });

  app.post("/api/v2/auth/device", async (context) => {
    if (!authorization) return context.json({ error: { code: "NOT_SUPPORTED", message: "CLI authorization is not configured" } }, 501);
    let address = "unknown";
    try {
      address = getConnInfo(context).remote.address || address;
    } catch {
      // app.request() has no socket; a shared test/local bucket is still bounded.
    }
    const normalizedAddress = address.startsWith("::ffff:") ? address.slice(7) : address;
    const trustedProxySet = new Set(trustedProxies.filter((candidate) => isIP(candidate)).map((candidate) => candidate.startsWith("::ffff:") ? candidate.slice(7) : candidate));
    if (trustedProxySet.has(normalizedAddress)) {
      const forwarded = context.req.header("CF-Connecting-IP") || context.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
      if (forwarded && isIP(forwarded)) address = forwarded;
    }
    const cutoff = Date.now() - 60_000;
    for (const [key, timestamps] of deviceAttempts) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff);
      if (recent.length) deviceAttempts.set(key, recent);
      else deviceAttempts.delete(key);
    }
    while (deviceAttempts.size >= 2_048 && !deviceAttempts.has(address)) {
      const oldest = deviceAttempts.keys().next().value;
      if (oldest === undefined) break;
      deviceAttempts.delete(oldest);
    }
    const attempts = (deviceAttempts.get(address) || []).filter((timestamp) => timestamp > cutoff);
    if (attempts.length >= 10) return context.json({ error: { code: "TOO_MANY_REQUESTS", message: "Too many CLI authorization attempts" } }, 429);
    attempts.push(Date.now());
    deviceAttempts.set(address, attempts);
    const body = deviceRequestInputSchema.parse(await limitedJson(context.req.raw));
    const label = body.label || "Prompt Vault CLI";
    return context.json(await authorization.createDeviceRequest({
      label,
      verificationOrigin: publicOrigin || new URL(context.req.url).origin,
    }), 201);
  });

  app.post("/api/v2/auth/device/token", async (context) => {
    if (!authorization) return context.json({ error: { code: "NOT_SUPPORTED", message: "CLI authorization is not configured" } }, 501);
    context.header("Cache-Control", "no-store");
    const { deviceCode } = deviceTokenInputSchema.parse(await limitedJson(context.req.raw));
    const state = await authorization.exchangeDeviceCode(deviceCode);
    if (!state) return context.json({ error: { code: "NOT_FOUND", message: "Authorization request not found" } }, 404);
    if (state.status === "pending") return context.json(state, 202);
    if (state.status === "slow_down") return context.json(state, 429);
    if (state.status === "denied") return context.json(state, 403);
    if (state.status === "expired") return context.json(state, 410);
    return context.json(state);
  });

  app.delete("/api/v2/auth/device/token", async (context) => {
    if (!authorization) return context.json({ error: { code: "NOT_SUPPORTED", message: "CLI authorization is not configured" } }, 501);
    const { deviceCode } = deviceTokenInputSchema.parse(await limitedJson(context.req.raw));
    await authorization.discardDeviceRequest(deviceCode);
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });

  app.get("/api/v2/auth/requests", async (context) => {
    if (context.get("identity")?.kind !== "host") return context.json({ error: { code: "FORBIDDEN", message: "Vault Host authorization is required" } }, 403);
    return context.json(await authorization?.listPendingRequests() || []);
  });

  app.post("/api/v2/auth/device/approve", async (context) => {
    if (context.get("identity")?.kind !== "host") return context.json({ error: { code: "FORBIDDEN", message: "Vault Host authorization is required" } }, 403);
    const body = deviceApprovalInputSchema.parse(await limitedJson(context.req.raw));
    const approved = await authorization?.approveDeviceRequest(body.userCode);
    return approved ? context.body(null, 204) : context.json({ error: { code: "INVALID_REQUEST", message: "Authorization request or code is invalid" } }, 400);
  });

  app.post("/api/v2/auth/device/deny", async (context) => {
    if (context.get("identity")?.kind !== "host") return context.json({ error: { code: "FORBIDDEN", message: "Vault Host authorization is required" } }, 403);
    const body = deviceApprovalInputSchema.parse(await limitedJson(context.req.raw));
    const denied = await authorization?.denyDeviceRequest(body.userCode);
    return denied ? context.body(null, 204) : context.json({ error: { code: "INVALID_REQUEST", message: "Authorization request or code is invalid" } }, 400);
  });

  app.get("/api/v2/auth/session", (context) => context.json(context.get("identity")));
  app.delete("/api/v2/auth/session", async (context) => {
    const identity = context.get("identity");
    if (identity?.kind !== "cli") return context.json({ error: { code: "FORBIDDEN", message: "Only CLI credentials can revoke themselves" } }, 403);
    const authorizationHeader = context.req.header("Authorization") || "";
    const supplied = authorizationHeader.startsWith("Bearer ") ? authorizationHeader.slice(7) : "";
    await authorization?.revoke(supplied);
    return context.body(null, 204);
  });

  app.get("/api/v2/auth/credentials", async (context) => {
    if (context.get("identity")?.kind !== "host") return context.json({ error: { code: "FORBIDDEN", message: "Vault Host authorization is required" } }, 403);
    return context.json(await authorization?.listCredentials() || []);
  });
  app.delete("/api/v2/auth/credentials/:id", async (context) => {
    if (context.get("identity")?.kind !== "host") return context.json({ error: { code: "FORBIDDEN", message: "Vault Host authorization is required" } }, 403);
    return await authorization?.revokeById(context.req.param("id"))
      ? context.body(null, 204)
      : context.json({ error: { code: "NOT_FOUND", message: "CLI credential not found" } }, 404);
  });

  app.get("/api/v2/themes", async (context) => {
    const summaries = await vault.listThemes(context.req.query("q") || "");
    if (context.req.query("detail") !== "true") return context.json(summaries);
    return context.json(await Promise.all(summaries.map((summary) => vault.getTheme(summary.slug))));
  });
  app.get("/api/v2/capabilities", (context) => context.json(vault.getCapabilities()));
  app.get("/api/v2/statistics", async (context) => context.json(await vault.getStatistics()));
  app.get("/api/v2/export", async (context) => context.json(await vault.exportVault()));
  app.post("/api/v2/workspace/synchronize", async (context) => context.json(await vault.synchronizeWorkspace()));
  app.post("/api/v2/themes", async (context) => {
    const input = themeInputSchema.parse(await limitedJson(context.req.raw, 3 * 1024 * 1024));
    return context.json(await vault.createTheme(input), 201);
  });
  app.get("/api/v2/themes/:slug", async (context) => context.json(await vault.getTheme(context.req.param("slug"))));
  app.post("/api/v2/themes/:slug/duplicate", async (context) => context.json(await vault.duplicateTheme(context.req.param("slug")), 201));
  app.delete("/api/v2/themes/:slug", async (context) => {
    await vault.deleteTheme(context.req.param("slug"));
    return context.body(null, 204);
  });
  app.patch("/api/v2/themes/:slug/draft", async (context) => {
    const input = draftUpdateSchema.parse(await limitedJson(context.req.raw, 3 * 1024 * 1024));
    return context.json(await vault.updateDraft(context.req.param("slug"), input));
  });
  app.post("/api/v2/themes/:slug/draft/apply", async (context) => {
    const form = await limitedFormData(context.req.raw);
    const editValue = form.get("edit");
    if (typeof editValue !== "string") throw new HttpError(400, "INVALID_REQUEST", "edit must contain JSON");
    let rawEdit: unknown;
    try {
      rawEdit = JSON.parse(editValue);
    } catch {
      throw new HttpError(400, "INVALID_JSON", "edit must contain valid JSON");
    }
    const edit = applyDraftEditSchema.parse(rawEdit);
    const assets: ApplyDraftEditInput["assets"] = { ...edit.assets };
    for (const kind of ["reference", "result"] as const) {
      const entries = form.getAll(`${kind}_files`);
      if (entries.some((entry) => typeof entry === "string")) throw new HttpError(400, "INVALID_REQUEST", `${kind}_files must contain files`);
      if (entries.length) {
        assets[kind] = {
          ...assets[kind],
          uploads: await Promise.all(entries.map(async (entry) => ({
            name: (entry as File).name,
            content: new Uint8Array(await (entry as File).arrayBuffer()),
          }))),
        };
      }
    }
    const identity = context.get("identity");
    return context.json(await vault.applyDraftEdit(context.req.param("slug"), {
      ...edit,
      assets,
      saveRevision: edit.saveRevision ? { ...edit.saveRevision, actor: identity?.label || "browser" } : undefined,
    }));
  });
  app.post("/api/v2/themes/:slug/draft/discard", async (context) => context.json(await vault.discardDraft(context.req.param("slug"))));
  app.post("/api/v2/themes/:slug/assets", async (context) => {
    const form = await limitedFormData(context.req.raw);
    const kind = assetKindSchema.parse(form.get("kind")) as AssetKind;
    const entries = form.getAll("files");
    if (!entries.length || entries.some((entry) => typeof entry === "string")) {
      throw new HttpError(400, "INVALID_REQUEST", "At least one image file is required");
    }
    const files = await Promise.all(entries.map(async (entry) => ({
      name: (entry as File).name,
      content: new Uint8Array(await (entry as File).arrayBuffer()),
    })));
    return context.json(await vault.addAssets(context.req.param("slug"), kind, files), 201);
  });
  app.get("/api/v2/themes/:slug/assets/:kind/:name", async (context) => {
    const kind = assetKindSchema.parse(context.req.param("kind")) as AssetKind;
    return assetResponse(await vault.readDraftAsset(context.req.param("slug"), kind, context.req.param("name")));
  });
  app.put("/api/v2/themes/:slug/assets/:kind/order", async (context) => {
    const kind = assetKindSchema.parse(context.req.param("kind")) as AssetKind;
    const input = assetOrderInputSchema.parse(await limitedJson(context.req.raw, 3 * 1024 * 1024));
    return context.json(await vault.reorderAssets(context.req.param("slug"), kind, input.names));
  });
  app.delete("/api/v2/themes/:slug/assets/:kind/:name", async (context) => {
    const kind = assetKindSchema.parse(context.req.param("kind")) as AssetKind;
    return context.json(await vault.removeAsset(context.req.param("slug"), kind, context.req.param("name")));
  });
  app.post("/api/v2/themes/:slug/revisions", async (context) => {
    const input = saveRevisionInputSchema.parse(await limitedJson(context.req.raw, 64 * 1024));
    const identity = context.get("identity");
    return context.json(await vault.saveRevision(context.req.param("slug"), {
      ...input,
      actor: identity?.label || "browser",
    }), 201);
  });
  app.get("/api/v2/themes/:slug/revisions/compare", async (context) => {
    const left = revisionIdSchema.parse(context.req.query("left"));
    const right = revisionIdSchema.parse(context.req.query("right"));
    return context.json(await vault.compareRevisions(context.req.param("slug"), left, right));
  });
  app.get("/api/v2/themes/:slug/revisions/:revisionId/assets/:kind/:name", async (context) => {
    const revisionId = revisionIdSchema.parse(context.req.param("revisionId"));
    const kind = assetKindSchema.parse(context.req.param("kind")) as AssetKind;
    return assetResponse(await vault.readRevisionAsset(context.req.param("slug"), revisionId, kind, context.req.param("name")), true);
  });
  app.get("/api/v2/themes/:slug/revisions/:revisionId", async (context) => {
    const revisionId = revisionIdSchema.parse(context.req.param("revisionId"));
    return context.json(await vault.getRevision(context.req.param("slug"), revisionId));
  });
  app.put("/api/v2/themes/:slug/revisions/:revisionId", async (context) => {
    const revisionId = revisionIdSchema.parse(context.req.param("revisionId"));
    const form = await limitedFormData(context.req.raw);
    const editValue = form.get("edit");
    if (typeof editValue !== "string") throw new HttpError(400, "INVALID_REQUEST", "edit must contain JSON");
    let rawEdit: unknown;
    try {
      rawEdit = JSON.parse(editValue);
    } catch {
      throw new HttpError(400, "INVALID_JSON", "edit must contain valid JSON");
    }
    const edit = overwriteRevisionEditSchema.parse(rawEdit);
    const assets: ApplyDraftEditInput["assets"] = { ...edit.assets };
    for (const kind of ["reference", "result"] as const) {
      const entries = form.getAll(`${kind}_files`);
      if (entries.some((entry) => typeof entry === "string")) throw new HttpError(400, "INVALID_REQUEST", `${kind}_files must contain files`);
      if (entries.length) {
        assets[kind] = {
          ...assets[kind],
          uploads: await Promise.all(entries.map(async (entry) => ({
            name: (entry as File).name,
            content: new Uint8Array(await (entry as File).arrayBuffer()),
          }))),
        };
      }
    }
    const identity = context.get("identity");
    return context.json(await vault.overwriteRevision(context.req.param("slug"), revisionId, {
      ...edit,
      assets,
      actor: identity?.label || "browser",
    }));
  });
  app.patch("/api/v2/themes/:slug/nodes/:nodeId/title", async (context) => {
    const revisionId = context.req.param("nodeId") === "working" ? null : revisionIdSchema.parse(context.req.param("nodeId"));
    const { title } = nodeTitleSchema.parse(await limitedJson(context.req.raw, 20_100));
    return context.json(await vault.setNodeTitle(context.req.param("slug"), revisionId, title));
  });
  app.patch("/api/v2/themes/:slug/revisions/:revisionId/marks", async (context) => {
    const revisionId = revisionIdSchema.parse(context.req.param("revisionId"));
    const marks = revisionMarksSchema.parse(await limitedJson(context.req.raw, 1_024));
    return context.json(await vault.setRevisionMarks(context.req.param("slug"), revisionId, marks));
  });
  app.delete("/api/v2/themes/:slug/revisions/:revisionId", async (context) => {
    const revisionId = revisionIdSchema.parse(context.req.param("revisionId"));
    const force = forceQuerySchema.parse(context.req.query("force"));
    return context.json(await vault.deleteRevision(context.req.param("slug"), revisionId, { force }));
  });
  app.get("/api/v2/themes/:slug/lineage", async (context) => context.json(await vault.getLineage(context.req.param("slug"))));
  app.post("/api/v2/themes/:slug/revisions/:revisionId/continue", async (context) => {
    const revisionId = revisionIdSchema.parse(context.req.param("revisionId"));
    const input = replaceDraftInputSchema.parse(await limitedJson(context.req.raw, 1_024));
    return context.json(await vault.continueFromRevision(context.req.param("slug"), revisionId, input));
  });
  app.post("/api/v2/themes/:slug/revisions/:revisionId/restore", async (context) => {
    const revisionId = revisionIdSchema.parse(context.req.param("revisionId"));
    const input = replaceDraftInputSchema.parse(await limitedJson(context.req.raw, 1_024));
    return context.json(await vault.restoreRevision(context.req.param("slug"), revisionId, input));
  });

  if (staticDirectory) {
    app.get("/favicon.ico", (context) => context.body(null, 204));
    app.use("/assets/*", async (context, next) => {
      await next();
      if (context.res.ok) context.res.headers.set("Cache-Control", staticCacheControl(context.req.path));
    });
    app.use("/assets/*", serveStatic({ root: staticDirectory }));
    app.use("/static/dist/*", async (context, next) => {
      await next();
      if (context.res.ok) context.res.headers.set("Cache-Control", staticCacheControl(context.req.path));
    });
    app.use("/static/dist/*", serveStatic({
      root: staticDirectory,
      rewriteRequestPath: (path) => path.replace(/^\/static\/dist\/?/, "/"),
    }));
    app.get("/", async (context, next) => {
      await next();
      if (context.res.ok) context.res.headers.set("Cache-Control", "no-cache");
    }, serveStatic({ path: join(staticDirectory, "index.html") }));
  }

  app.onError((error, context) => {
    if (error instanceof ZodError) {
      return context.json({ error: { code: "INVALID_REQUEST", message: error.issues[0]?.message || "Request validation failed" } }, 400);
    }
    if (error instanceof VaultError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.code === "NOT_FOUND" ? 404 : 400);
    }
    if (error instanceof AuthorizationError) {
      return context.json({ error: { code: error.code, message: error.message } }, 429);
    }
    if (error instanceof HttpError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return context.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
  });
  app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "API route not found" } }, 404));

  return app;
}
