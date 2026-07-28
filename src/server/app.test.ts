// @vitest-environment node

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuthorizationStore } from "../core/authorization.js";
import { createPromptVault } from "../core/prompt-vault.js";
import { copyLegacyWorkspace } from "../test/workspace.js";
import { createHttpApp } from "./app.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("Prompt Vault HTTP adapter", () => {
  it("serves the production browser bundle from the Node host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-static-"));
    const staticDirectory = join(directory, "static");
    await mkdir(join(staticDirectory, "assets"), { recursive: true });
    await writeFile(join(staticDirectory, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
    await writeFile(join(staticDirectory, "assets", "app.js"), "window.promptVault = true;", "utf8");
    await writeFile(join(staticDirectory, "assets", "app-deadbeef.js"), "window.promptVaultHashed = true;", "utf8");
    await writeFile(join(staticDirectory, "assets", "font.woff2"), "font", "utf8");
    const app = createHttpApp({
      vault: createPromptVault({ workspace: join(directory, "workspace") }),
      token: "host-token",
      staticDirectory,
    });

    const index = await app.request("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("id=\"root\"");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect((await app.request("/favicon.ico")).status).toBe(204);
    const asset = await app.request("/static/dist/assets/app.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("promptVault");
    expect(asset.headers.get("cache-control")).toBe("no-cache");
    expect((await app.request("/static/dist/assets/app-deadbeef.js")).headers.get("cache-control")).toContain("immutable");
    const font = await app.request("/assets/font.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("cache-control")).toBe("no-cache");
  });

  it("refuses to start without an authentication provider", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-auth-required-")) });

    expect(() => createHttpApp({ vault })).toThrow(/authentication must be configured/);
  });

  it("exchanges the host token for an HTTP-only browser session", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-browser-auth-")) });
    const app = createHttpApp({ vault, token: "host-token", publicOrigin: "https://vault.test" });

    const rejected = await app.request("https://vault.test/api/v2/auth/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(rejected.status).toBe(401);

    const signedIn = await app.request("https://vault.test/api/v2/auth/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "host-token" }),
    });
    expect(signedIn.status).toBe(204);
    const cookie = signedIn.headers.get("set-cookie") || "";
    expect(cookie).toContain("prompt_vault_token=host-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");

    const session = await app.request("https://vault.test/api/v2/auth/session", {
      headers: { Cookie: cookie.split(";")[0] },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ kind: "host", label: "Vault Host" });
  });

  it("serves the read contract and enforces the current host token", async () => {
    const vault = createPromptVault({ workspace: await copyLegacyWorkspace() });
    const app = createHttpApp({ vault, token: "host-token" });

    expect((await app.request("/api/v2/themes")).status).toBe(401);

    const response = await app.request("/api/v2/themes/legacy-fixture", {
      headers: { Authorization: "Bearer host-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      slug: "legacy-fixture",
      baseRevision: 1,
      revisionCount: 1,
      draft: { prompt: "first prompt" },
    });

    const listResponse = await app.request("/api/v2/themes", {
      headers: { "X-Vault-Token": "host-token" },
    });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject([{ slug: "legacy-fixture" }]);
  });

  it("includes every revision image in the Theme summary for node carousels", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-carousel-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };
    const created = await app.request("/api/v2/themes", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Carousel", prompt: "first draft" }),
    });
    const theme = await created.json() as { slug: string };
    const form = new FormData();
    form.set("kind", "result");
    form.append("files", new Blob([png], { type: "image/png" }), "first.png");
    form.append("files", new Blob([png], { type: "image/png" }), "second.png");
    await app.request(`/api/v2/themes/${theme.slug}/assets`, {
      method: "POST",
      headers: { Authorization: "Bearer host-token" },
      body: form,
    });

    const saved = await app.request(`/api/v2/themes/${theme.slug}/revisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "Two images" }),
    });

    const savedTheme = await saved.json() as { revisions: Array<{ previewAssets: Array<{ kind: string; name: string; sha256: string }> }> };
    expect(savedTheme).toMatchObject({
      revisions: [{
        previewAssets: [
          { kind: "result", name: "first.png" },
          { kind: "result", name: "second.png" },
        ],
      }],
    });
    expect(savedTheme.revisions[0].previewAssets.map((asset) => asset.sha256)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });

  it("stores mutable node titles outside immutable Revision history", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-node-title-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };
    const created = await app.request("/api/v2/themes", { method: "POST", headers, body: JSON.stringify({ title: "Titles", prompt: "draft" }) });
    const theme = await created.json() as { slug: string };
    const working = await app.request(`/api/v2/themes/${theme.slug}/nodes/working/title`, { method: "PATCH", headers, body: JSON.stringify({ title: "Working name" }) });
    expect(await working.json()).toMatchObject({ workingTitle: "Working name" });
    const saved = await app.request(`/api/v2/themes/${theme.slug}/revisions`, { method: "POST", headers, body: JSON.stringify({ note: "Original name" }) });
    expect(saved.status).toBe(201);
    const renamed = await app.request(`/api/v2/themes/${theme.slug}/nodes/1/title`, { method: "PATCH", headers, body: JSON.stringify({ title: "Renamed node" }) });
    expect(await renamed.json()).toMatchObject({ revisions: [{ id: 1, note: "Renamed node" }] });
    expect((await vault.getRevision(theme.slug, 1)).note).toBe("Renamed node");
  });

  it("creates and edits Drafts and manages Assets through the authenticated contract", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-draft-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };

    const created = await app.request("/api/v2/themes", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Tea Party", prompt: "first draft", tags: ["tea"] }),
    });
    expect(created.status).toBe(201);
    const theme = await created.json() as { slug: string };
    expect(theme).toMatchObject({ slug: "tea-party", baseRevision: null, revisionCount: 0 });

    const updated = await app.request(`/api/v2/themes/${theme.slug}/draft`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ prompt: "second draft", notes: "working notes" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      hasUnsavedChanges: true,
      revisionCount: 0,
      draft: { prompt: "second draft", notes: "working notes" },
    });

    const form = new FormData();
    form.set("kind", "result");
    form.append("files", new Blob([png], { type: "image/png" }), "z-result.png");
    form.append("files", new Blob([png], { type: "image/png" }), "a-result.png");
    const uploaded = await app.request(`/api/v2/themes/${theme.slug}/assets`, {
      method: "POST",
      headers: { Authorization: "Bearer host-token" },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({ draft: { assets: { result: [{ name: "z-result.png" }, { name: "a-result.png" }] } } });
    const currentAsset = await app.request(`/api/v2/themes/${theme.slug}/assets/result/z-result.png`, {
      headers: { Authorization: "Bearer host-token" },
    });
    expect(currentAsset.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await currentAsset.arrayBuffer())).toEqual(png);
    const cookieAsset = await app.request(`/api/v2/themes/${theme.slug}/assets/result/z-result.png`, {
      headers: { Cookie: "prompt_vault_token=host-token" },
    });
    expect(cookieAsset.status).toBe(200);
    expect(Buffer.from(await cookieAsset.arrayBuffer())).toEqual(png);

    const reordered = await app.request(`/api/v2/themes/${theme.slug}/assets/result/order`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ names: ["a-result.png", "z-result.png"] }),
    });
    expect(reordered.status).toBe(200);
    expect(await reordered.json()).toMatchObject({ draft: { assets: { result: [{ name: "a-result.png" }, { name: "z-result.png" }] } } });

    const removed = await app.request(`/api/v2/themes/${theme.slug}/assets/result/a-result.png`, {
      method: "DELETE",
      headers: { Authorization: "Bearer host-token" },
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ draft: { assets: { result: [{ name: "z-result.png" }] } } });

    const discarded = await app.request(`/api/v2/themes/${theme.slug}/draft/discard`, {
      method: "POST",
      headers: { Authorization: "Bearer host-token" },
    });
    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toMatchObject({ hasUnsavedChanges: false, revisionCount: 0, draft: { prompt: "", notes: "" } });
  });

  it("rejects invalid Draft mutation bodies without changing the Theme", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-invalid-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };

    const invalidCreate = await app.request("/api/v2/themes", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: ["not", "text"] }),
    });
    expect(invalidCreate.status).toBe(400);
    expect(await invalidCreate.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const created = await app.request("/api/v2/themes", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Stable", prompt: "keep me" }),
    });
    const theme = await created.json() as { slug: string };
    const invalidUpdate = await app.request(`/api/v2/themes/${theme.slug}/draft`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ tags: "not-an-array" }),
    });
    expect(invalidUpdate.status).toBe(400);
    expect(await vault.getTheme(theme.slug)).toMatchObject({ draft: { prompt: "keep me" }, tags: [] });

    const invalidReference = await app.request(`/api/v2/themes/${theme.slug}/draft`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ referenceUrls: ["javascript:alert(1)"] }),
    });
    expect(invalidReference.status).toBe(400);
  });

  it("allows cookie-authenticated media but rejects cross-origin cookie mutations", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-csrf-")) });
    const app = createHttpApp({ vault, token: "host-token", publicOrigin: "http://vault.test" });
    const created = await app.request("http://vault.test/api/v2/themes", {
      method: "POST",
      headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "CSRF", prompt: "dirty" }),
    });
    const theme = await created.json() as { slug: string };

    const rejected = await app.request(`http://vault.test/api/v2/themes/${theme.slug}/draft/discard`, {
      method: "POST",
      headers: { Cookie: "prompt_vault_token=host-token", Origin: "http://attacker.test" },
    });
    expect(rejected.status).toBe(403);
    expect((await vault.getTheme(theme.slug)).hasUnsavedChanges).toBe(true);
    const accepted = await app.request(`http://vault.test/api/v2/themes/${theme.slug}/draft/discard`, {
      method: "POST",
      headers: { Cookie: "prompt_vault_token=host-token", Origin: "http://vault.test" },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("saves, inspects, continues, restores, and compares Revision Lineage", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-revision-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };
    const createResponse = await app.request("/api/v2/themes", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "HTTP Lineage", prompt: "root" }),
    });
    const theme = await createResponse.json() as { slug: string };
    const assetForm = new FormData();
    assetForm.set("kind", "reference");
    assetForm.append("files", new Blob([png], { type: "image/png" }), "source.png");
    expect((await app.request(`/api/v2/themes/${theme.slug}/assets`, {
      method: "POST",
      headers: { Authorization: "Bearer host-token" },
      body: assetForm,
    })).status).toBe(201);

    const root = await app.request(`/api/v2/themes/${theme.slug}/revisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "Root" }),
    });
    expect(root.status).toBe(201);
    await app.request(`/api/v2/themes/${theme.slug}/draft`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ prompt: "second", model: "Flux" }),
    });
    const second = await app.request(`/api/v2/themes/${theme.slug}/revisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "Second" }),
    });
    expect(second.status).toBe(201);

    const revision = await app.request(`/api/v2/themes/${theme.slug}/revisions/1`, { headers });
    expect(await revision.json()).toMatchObject({ id: 1, parentIds: [], draft: { prompt: "root" } });
    const revisionAsset = await app.request(`/api/v2/themes/${theme.slug}/revisions/1/assets/reference/source.png`, { headers });
    expect(revisionAsset.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await revisionAsset.arrayBuffer())).toEqual(png);
    const lineage = await app.request(`/api/v2/themes/${theme.slug}/lineage`, { headers });
    expect(await lineage.json()).toMatchObject({ edges: [{ parentId: 1, childId: 2 }] });
    const comparison = await app.request(`/api/v2/themes/${theme.slug}/revisions/compare?left=1&right=2`, { headers });
    expect(await comparison.json()).toMatchObject({ metadataChanges: [{ field: "model", left: "", right: "Flux" }] });

    await app.request(`/api/v2/themes/${theme.slug}/draft`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ prompt: "unsaved" }),
    });
    const refused = await app.request(`/api/v2/themes/${theme.slug}/revisions/1/continue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ force: false }),
    });
    expect(refused.status).toBe(400);
    const continued = await app.request(`/api/v2/themes/${theme.slug}/revisions/1/continue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ force: true }),
    });
    expect(await continued.json()).toMatchObject({ baseRevision: 1, hasUnsavedChanges: false, draft: { prompt: "root" } });
    const restored = await app.request(`/api/v2/themes/${theme.slug}/revisions/2/restore`, {
      method: "POST",
      headers,
      body: JSON.stringify({ force: false }),
    });
    expect(await restored.json()).toMatchObject({ baseRevision: 1, hasUnsavedChanges: true, draft: { prompt: "second" } });
  });

  it("applies browser editor changes as one host-side transaction", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-editor-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };
    const created = await app.request("/api/v2/themes", { method: "POST", headers, body: JSON.stringify({ title: "Editor", prompt: "root" }) });
    const theme = await created.json() as { slug: string };
    await app.request(`/api/v2/themes/${theme.slug}/revisions`, { method: "POST", headers, body: JSON.stringify({ note: "Root" }) });

    const invalidForm = new FormData();
    invalidForm.set("edit", JSON.stringify({ sourceRevisionId: 1, update: { prompt: "partial" }, saveRevision: { note: "Broken" } }));
    invalidForm.append("result_files", new Blob(["not an image"]), "broken.png");
    const invalid = await app.request(`/api/v2/themes/${theme.slug}/draft/apply`, {
      method: "POST",
      headers: { Authorization: "Bearer host-token" },
      body: invalidForm,
    });
    expect(invalid.status).toBe(400);
    expect(await vault.getTheme(theme.slug)).toMatchObject({ baseRevision: 1, revisionCount: 1, draft: { prompt: "root" } });

    const form = new FormData();
    form.set("edit", JSON.stringify({
      sourceRevisionId: 1,
      update: { prompt: "child" },
      assets: { result: { order: [{ source: "upload", index: 0 }] } },
      saveRevision: { note: "Child", parentIds: [1] },
    }));
    form.append("result_files", new Blob([png], { type: "image/png" }), "child.png");
    const saved = await app.request(`/api/v2/themes/${theme.slug}/draft/apply`, {
      method: "POST",
      headers: { Authorization: "Bearer host-token" },
      body: form,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ baseRevision: 2, revisionCount: 2, hasUnsavedChanges: false, draft: { prompt: "child" } });
  });

  it("saves the editable working-node title with the rest of its modal fields", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-working-title-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };
    const created = await app.request("/api/v2/themes", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Working title", prompt: "before" }),
    });
    const theme = await created.json() as { slug: string };
    const form = new FormData();
    form.set("edit", JSON.stringify({ nodeTitle: "Renamed node", update: { prompt: "after" } }));

    const saved = await app.request(`/api/v2/themes/${theme.slug}/draft/apply`, {
      method: "POST",
      headers: { Authorization: "Bearer host-token" },
      body: form,
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ workingTitle: "Renamed node", draft: { prompt: "after" } });
  });

  it("overwrites the displayed node without creating a Draft node or a new child", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-overwrite-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };
    const created = await app.request("/api/v2/themes", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Overwrite", prompt: "before" }),
    });
    const theme = await created.json() as { slug: string };
    await app.request(`/api/v2/themes/${theme.slug}/revisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ note: "Original" }),
    });

    const form = new FormData();
    form.set("edit", JSON.stringify({
      note: "Updated",
      update: { prompt: "after", model: "Flux" },
      assets: { result: { order: [{ source: "upload", index: 0 }] } },
    }));
    form.append("result_files", new Blob([png], { type: "image/png" }), "updated.png");
    const overwritten = await app.request(`/api/v2/themes/${theme.slug}/revisions/1`, {
      method: "PUT",
      headers: { Authorization: "Bearer host-token" },
      body: form,
    });

    expect(overwritten.status).toBe(200);
    expect(await overwritten.json()).toMatchObject({
      baseRevision: 1,
      revisionCount: 1,
      hasUnsavedChanges: false,
      draft: { prompt: "after", model: "Flux", assets: { result: [{ name: "updated.png" }] } },
      revisions: [{ id: 1, note: "Updated", parentIds: [] }],
    });
    expect(await vault.getRevision(theme.slug, 1)).toMatchObject({
      id: 1,
      note: "Updated",
      draft: { prompt: "after", model: "Flux", assets: { result: [{ name: "updated.png" }] } },
    });
  });

  it("exposes management operations and their safety rules", async () => {
    const vault = createPromptVault({ workspace: await mkdtemp(join(tmpdir(), "prompt-vault-http-management-")) });
    const app = createHttpApp({ vault, token: "host-token" });
    const headers = { Authorization: "Bearer host-token", "Content-Type": "application/json" };
    const created = await app.request("/api/v2/themes", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Managed", prompt: "root" }),
    });
    const theme = await created.json() as { slug: string };
    await app.request(`/api/v2/themes/${theme.slug}/revisions`, { method: "POST", headers, body: JSON.stringify({ note: "Root" }) });
    const archived = await app.request(`/api/v2/themes/${theme.slug}/draft`, { method: "PATCH", headers, body: JSON.stringify({ archived: true, starred: true }) });
    expect(await archived.json()).toMatchObject({ archived: true, starred: true });

    const marked = await app.request(`/api/v2/themes/${theme.slug}/revisions/1/marks`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ featured: true }),
    });
    expect(await marked.json()).toMatchObject({ revisions: [{ id: 1, featured: true }] });
    const duplicate = await app.request(`/api/v2/themes/${theme.slug}/duplicate`, { method: "POST", headers });
    expect(duplicate.status).toBe(201);
    const duplicateTheme = await duplicate.json() as { slug: string };

    expect(await (await app.request("/api/v2/statistics", { headers })).json()).toMatchObject({ themes: 2, active: 1, archived: 1, starred: 1, revisions: 1 });
    expect(await (await app.request("/api/v2/export", { headers })).json()).toMatchObject({ format: "prompt-vault/themes/v2" });
    expect(await (await app.request("/api/v2/workspace/synchronize", { method: "POST", headers })).json()).toMatchObject({ count: 1 });
    const capabilities = await (await app.request("/api/v2/capabilities", { headers })).json();
    expect(capabilities).toMatchObject({ format: "prompt-vault/capabilities/v1" });
    expect(JSON.stringify(capabilities)).not.toMatch(/branch|checkout|commit|working tree/i);

    expect((await app.request(`/api/v2/themes/${duplicateTheme.slug}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await app.request(`/api/v2/themes/${duplicateTheme.slug}`, { headers })).status).toBe(404);
    expect((await app.request(`/api/v2/themes/${theme.slug}/revisions/1`, { method: "DELETE", headers })).status).toBe(200);
  });

  it("issues a revocable CLI credential only after browser authorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-auth-"));
    const vault = createPromptVault({ workspace: await copyLegacyWorkspace() });
    const credentialDirectory = join(directory, "credentials");
    const authorization = await createAuthorizationStore({ credentialDirectory });
    const app = createHttpApp({ vault, token: "host-token", authorization, publicOrigin: "http://vault.test" });

    const created = await app.request("http://vault.test/api/v2/auth/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Test CLI" }),
    });
    expect(created.status).toBe(201);
    const request = await created.json() as { requestId: string; userCode: string; verificationUri: string };
    expect(request).toMatchObject({ userCode: expect.stringMatching(/^[A-Z0-9]{8}$/) });
    expect(request.verificationUri).toContain(`/auth/cli/${request.requestId}`);
    const approvalPage = await app.request(request.verificationUri);
    expect(approvalPage.status).toBe(200);
    expect(approvalPage.headers.get("x-frame-options")).toBe("DENY");
    expect(approvalPage.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const approvalHtml = await approvalPage.text();
    expect(approvalHtml).toContain("Application: <strong>Test CLI</strong>");
    expect(approvalHtml).toContain(`Code: <strong>${request.userCode}</strong>`);
    expect(approvalHtml).not.toContain("localStorage");
    expect(approvalHtml).not.toContain("X-Vault-Token");

    expect((await app.request(`/api/v2/auth/device/${request.requestId}`)).status).toBe(202);
    expect((await app.request(`/api/v2/auth/device/${request.requestId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: request.userCode }),
    })).status).toBe(401);

    const browserLogin = await app.request("http://vault.test/api/v2/auth/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "host-token" }),
    });
    const browserCookie = (browserLogin.headers.get("set-cookie") || "").split(";")[0];
    const approvals = await Promise.all([1, 2].map(() => app.request(`/api/v2/auth/device/${request.requestId}/approve`, {
      method: "POST",
      headers: { Cookie: browserCookie, Origin: "http://vault.test", "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: request.userCode }),
    })));
    expect(approvals.map((response) => response.status).sort()).toEqual([204, 400]);

    const completed = await app.request(`/api/v2/auth/device/${request.requestId}`);
    expect(completed.status).toBe(200);
    const credential = await completed.json() as { status: string; token: string };
    expect(credential).toMatchObject({ status: "approved", token: expect.stringMatching(/^pv_/) });
    expect(completed.headers.get("cache-control")).toBe("no-store");
    const repeated = await app.request(`/api/v2/auth/device/${request.requestId}`);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(credential);

    const themes = await app.request("/api/v2/themes", { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(themes.status).toBe(200);
    const session = await app.request("/api/v2/auth/session", { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(await session.json()).toMatchObject({ kind: "cli", label: "Test CLI" });
    const reloaded = await createAuthorizationStore({ credentialDirectory });
    expect(await reloaded.authenticate(credential.token)).toMatchObject({ kind: "cli", label: "Test CLI" });

    expect((await app.request("/api/v2/auth/session", {
      method: "DELETE",
      headers: { "X-Vault-Token": credential.token },
    })).status).toBe(204);
    expect((await app.request("/api/v2/themes", { headers: { Authorization: `Bearer ${credential.token}` } })).status).toBe(401);

    expect(await reloaded.authenticate(credential.token)).toBeNull();
  });

  it("expires unapproved CLI authorization requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-auth-expiry-"));
    let now = Date.now();
    const authorization = await createAuthorizationStore({
      credentialDirectory: join(directory, "credentials"),
      now: () => now,
    });
    const app = createHttpApp({
      vault: createPromptVault({ workspace: await copyLegacyWorkspace() }),
      token: "host-token",
      authorization,
    });
    const created = await app.request("http://vault.test/api/v2/auth/device", { method: "POST" });
    const request = await created.json() as { requestId: string; expiresIn: number };
    now += request.expiresIn * 1_000 + 1;

    const expired = await app.request(`/api/v2/auth/device/${request.requestId}`);

    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ status: "expired" });
  });

  it("limits unauthenticated pending CLI authorization requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-auth-limit-"));
    const authorization = await createAuthorizationStore({
      credentialDirectory: join(directory, "credentials"),
      maxPending: 100,
    });
    const app = createHttpApp({
      vault: createPromptVault({ workspace: await copyLegacyWorkspace() }),
      token: "host-token",
      authorization,
    });

    for (let request = 0; request < 10; request += 1) {
      expect((await app.request("/api/v2/auth/device", { method: "POST" })).status).toBe(201);
    }
    const limited = await app.request("/api/v2/auth/device", { method: "POST" });

    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "TOO_MANY_REQUESTS" } });
  });

  it("does not count delivered CLI credentials against pending authorization capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-auth-capacity-"));
    const authorization = await createAuthorizationStore({ credentialDirectory: join(directory, "credentials"), maxPending: 1 });
    const app = createHttpApp({ vault: createPromptVault({ workspace: await copyLegacyWorkspace() }), token: "host-token", authorization });
    const first = await app.request("http://vault.test/api/v2/auth/device", { method: "POST" });
    const request = await first.json() as { requestId: string; userCode: string };
    expect((await app.request(`/api/v2/auth/device/${request.requestId}/approve`, {
      method: "POST",
      headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: request.userCode }),
    })).status).toBe(204);
    expect((await app.request(`/api/v2/auth/device/${request.requestId}`)).status).toBe(200);

    expect((await app.request("http://vault.test/api/v2/auth/device", { method: "POST" })).status).toBe(201);
  });

  it("stops buffering oversized chunked authorization requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-auth-body-"));
    const app = createHttpApp({
      vault: createPromptVault({ workspace: await copyLegacyWorkspace() }),
      token: "host-token",
      authorization: await createAuthorizationStore({ credentialDirectory: join(directory, "credentials") }),
    });
    const oversized = await app.request("/api/v2/auth/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x".repeat(2_000) }),
    });

    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("rejects non-object authorization JSON without an internal error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-auth-json-"));
    const app = createHttpApp({
      vault: createPromptVault({ workspace: await copyLegacyWorkspace() }),
      token: "host-token",
      authorization: await createAuthorizationStore({ credentialDirectory: join(directory, "credentials") }),
    });

    const response = await app.request("/api/v2/auth/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("returns the JSON error contract for unknown API routes", async () => {
    const app = createHttpApp({
      vault: createPromptVault({ workspace: await copyLegacyWorkspace() }),
      token: "host-token",
    });

    const response = await app.request("/api/v2/not-supported", {
      headers: { Authorization: "Bearer host-token" },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "API route not found" } });
  });
});
