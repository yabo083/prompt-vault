// @vitest-environment node

import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { createAuthorizationStore } from "../core/authorization.js";
import { createPromptVault } from "../core/prompt-vault.js";
import { createHttpApp } from "../server/app.js";
import { addMalformedTheme, copyLegacyWorkspace } from "../test/workspace.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function runCli(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, ["packages/cli/dist/index.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function waitForPendingRequest(host: string, token: string) {
  return (await waitForPendingRequests(host, token, 1))[0];
}

async function waitForPendingRequests(host: string, token: string, count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${host}/api/v2/auth/requests`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) {
      const requests = await response.json() as Array<{ requestId: string; userCode: string }>;
      if (requests.length >= count) return requests;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`CLI did not create ${count} authorization request(s)`);
}

describe("prompt-vault CLI process", () => {
  it("reports the published CLI version", async () => {
    const result = await runCli(["--version"], {});
    const manifest = JSON.parse(await readFile(join(process.cwd(), "packages/cli/package.json"), "utf8")) as { version: string };
    expect(result).toMatchObject({ code: 0, stdout: `${manifest.version}\n`, stderr: "" });
  });

  it("returns parser failures through the JSON error contract", async () => {
    const result = await runCli(["--json", "theme", "show"], {});

    expect(result).toMatchObject({ code: 2, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "USAGE" },
    });
  });

  it("rejects a cross-origin browser verification URI from a hostile host", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/v2/auth/device") {
        response.end(JSON.stringify({
          requestId: "1234567890123456",
          userCode: "ABCD1234",
          verificationUri: "https://attacker.example/authorize",
          expiresIn: 600,
          interval: 1,
        }));
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server");

    try {
      const result = await runCli(
        ["--json", "auth", "login", "--host", `http://127.0.0.1:${address.port}`, "--name", "hostile", "--no-browser"],
        { PROMPT_VAULT_CONFIG_DIR: join(tmpdir(), `prompt-vault-hostile-${Date.now()}`) },
      );
      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "INVALID_VERIFICATION_URI" } });
    } finally {
      server.close();
    }
  });

  it("configures a Vault Host through browser approval and revokes it on logout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-cli-auth-"));
    const configDirectory = join(directory, "config");
    const workspace = await copyLegacyWorkspace();
    await addMalformedTheme(workspace);
    const authorization = await createAuthorizationStore({ credentialDirectory: join(directory, "host-credentials") });
    const app = createHttpApp({
      vault: createPromptVault({ workspace }),
      token: "host-token",
      authorization,
    });
    const server = serve({ fetch: app.fetch, port: 0, createServer });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server");
    const host = `http://127.0.0.1:${address.port}`;
    const env = {
      PROMPT_VAULT_CONFIG_DIR: configDirectory,
      PROMPT_VAULT_CREDENTIAL_STORE: "file",
    };

    try {
      const login = runCli(["--json", "auth", "login", "--host", host, "--name", "test", "--no-browser"], env);
      const pending = await waitForPendingRequest(host, "host-token");
      const approval = await fetch(`${host}/api/v2/auth/device/${pending.requestId}/approve`, {
        method: "POST",
        headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: pending.userCode }),
      });
      expect(approval.status).toBe(204);
      const loggedIn = await login;
      expect(loggedIn.code).toBe(0);
      expect(loggedIn.stderr).toContain(`Open ${host}/auth/cli/`);
      expect(loggedIn.stderr).toContain(`Code: ${pending.userCode}`);
      expect(loggedIn.stdout).not.toContain("pv_");

      const requested = await runCli(["--json", "--host", host, "auth", "request", "--name", "test"], env);
      const requestPayload = JSON.parse(requested.stdout).data;
      expect(requestPayload).toMatchObject({ host: "test", url: host, userCode: expect.stringMatching(/^[A-Z0-9]{8}$/) });
      expect(requestPayload).not.toHaveProperty("token");
      const pendingCompletion = await runCli([
        "--json", "--host", host, "auth", "complete", "--name", "test", "--request", requestPayload.requestId,
      ], env);
      expect(JSON.parse(pendingCompletion.stdout)).toEqual({ ok: true, data: { status: "pending", host: "test", url: host } });
      expect((await fetch(`${host}/api/v2/auth/device/${requestPayload.requestId}/approve`, {
        method: "POST",
        headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: requestPayload.userCode }),
      })).status).toBe(204);
      const completed = await runCli([
        "--json", "--host", host, "auth", "complete", "--name", "test", "--request", requestPayload.requestId,
      ], env);
      expect(JSON.parse(completed.stdout)).toMatchObject({ ok: true, data: { status: "approved", host: "test", url: host, authenticated: true } });
      expect(completed.stdout).not.toContain("pv_");
      expect((await fetch(`${host}/api/v2/auth/device/${requestPayload.requestId}`)).status).toBe(404);

      const status = await runCli(["--json", "auth", "status", "--host", "test"], env);
      expect(JSON.parse(status.stdout)).toMatchObject({
        ok: true,
        data: { host: "test", url: host, authenticated: true, identity: { kind: "cli" } },
      });

      const listed = await runCli(["--json", "--host", "test", "theme", "list"], env);
      expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [{ slug: "legacy-fixture" }] });
      const shown = await runCli(["--json", "--host", "test", "theme", "show", "legacy-fixture"], env);
      expect(JSON.parse(shown.stdout)).toMatchObject({
        ok: true,
        data: { slug: "legacy-fixture", title: "Legacy Fixture", baseRevision: 1, revisionCount: 1 },
      });

      const created = await runCli([
        "--json", "--host", "test", "theme", "create",
        "--title", "CLI Draft", "--prompt", "first draft", "--tag", "cli", "--tag", "temporary",
      ], env);
      expect(created).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(created.stdout)).toMatchObject({
        ok: true,
        data: { slug: "cli-draft", tags: ["cli", "temporary"], baseRevision: null, revisionCount: 0, draft: { prompt: "first draft" } },
      });
      const updated = await runCli([
        "--json", "--host", "test", "draft", "update", "cli-draft",
        "--prompt", "second draft", "--notes", "cli notes", "--clear-tags", "--starred", "true",
      ], env);
      expect(updated).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(updated.stdout)).toMatchObject({
        ok: true,
        data: { tags: [], starred: true, hasUnsavedChanges: true, draft: { prompt: "second draft", notes: "cli notes" } },
      });

      const imagePath = join(directory, "cli-result.png");
      const secondImagePath = join(directory, "a-result.png");
      await writeFile(imagePath, png);
      await writeFile(secondImagePath, png);
      const uploaded = await runCli(["--json", "--host", "test", "asset", "add", "cli-draft", "result", imagePath, secondImagePath], env);
      expect(uploaded).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(uploaded.stdout)).toMatchObject({
        ok: true,
        data: { draft: { assets: { result: [{ name: "cli-result.png" }, { name: "a-result.png" }] } } },
      });
      const reordered = await runCli([
        "--json", "--host", "test", "asset", "reorder", "cli-draft", "result", "a-result.png", "cli-result.png",
      ], env);
      expect(reordered).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(reordered.stdout)).toMatchObject({
        ok: true,
        data: { draft: { assets: { result: [{ name: "a-result.png" }, { name: "cli-result.png" }] } } },
      });
      const removed = await runCli(["--json", "--host", "test", "asset", "remove", "cli-draft", "result", "a-result.png"], env);
      expect(removed).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(removed.stdout)).toMatchObject({ ok: true, data: { draft: { assets: { result: [{ name: "cli-result.png" }] } } } });
      const discarded = await runCli(["--json", "--host", "test", "draft", "discard", "cli-draft"], env);
      expect(discarded).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(discarded.stdout)).toMatchObject({
        ok: true,
        data: { hasUnsavedChanges: false, revisionCount: 0, draft: { prompt: "", notes: "" } },
      });

      expect((await runCli([
        "--json", "--host", "test", "draft", "update", "cli-draft", "--prompt", "revision root",
      ], env)).code).toBe(0);
      expect((await runCli([
        "--json", "--host", "test", "asset", "add", "cli-draft", "reference", imagePath,
      ], env)).code).toBe(0);
      const savedRoot = await runCli(["--json", "--host", "test", "revision", "save", "cli-draft", "--note", "Root"], env);
      expect(savedRoot).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(savedRoot.stdout)).toMatchObject({ ok: true, data: { baseRevision: 1, revisionCount: 1 } });
      const shownRevision = await runCli(["--json", "--host", "test", "revision", "show", "cli-draft", "1"], env);
      expect(JSON.parse(shownRevision.stdout)).toMatchObject({ ok: true, data: { id: 1, parentIds: [], draft: { prompt: "revision root" } } });
      const downloadedAssetPath = join(directory, "downloaded-revision.png");
      const downloadedAsset = await runCli([
        "--json", "--host", "test", "asset", "get", "cli-draft", "reference", "cli-result.png", "--revision", "1", "--output", downloadedAssetPath,
      ], env);
      expect(downloadedAsset).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(downloadedAsset.stdout)).toMatchObject({ ok: true, data: { path: downloadedAssetPath, mime: "image/png", revision: 1 } });
      expect(await readFile(downloadedAssetPath)).toEqual(png);

      expect((await runCli([
        "--json", "--host", "test", "draft", "update", "cli-draft", "--prompt", "revision second", "--model", "Flux",
      ], env)).code).toBe(0);
      expect((await runCli(["--json", "--host", "test", "revision", "save", "cli-draft", "--note", "Second"], env)).code).toBe(0);
      const shownLineage = await runCli(["--json", "--host", "test", "lineage", "show", "cli-draft"], env);
      expect(JSON.parse(shownLineage.stdout)).toMatchObject({ ok: true, data: { edges: [{ parentId: 1, childId: 2 }] } });
      const compared = await runCli(["--json", "--host", "test", "revision", "compare", "cli-draft", "1", "2"], env);
      expect(JSON.parse(compared.stdout)).toMatchObject({ ok: true, data: { metadataChanges: [{ field: "model", left: "", right: "Flux" }] } });

      expect((await runCli([
        "--json", "--host", "test", "draft", "update", "cli-draft", "--prompt", "unsaved revision work",
      ], env)).code).toBe(0);
      const refusedContinue = await runCli(["--json", "--host", "test", "revision", "continue", "cli-draft", "1"], env);
      expect(refusedContinue.code).toBe(1);
      expect(JSON.parse(refusedContinue.stdout)).toMatchObject({ ok: false, error: { code: "INVALID_WORKSPACE" } });
      const continuedRevision = await runCli(["--json", "--host", "test", "revision", "continue", "cli-draft", "1", "--force"], env);
      expect(JSON.parse(continuedRevision.stdout)).toMatchObject({ ok: true, data: { baseRevision: 1, hasUnsavedChanges: false } });
      const restoredRevision = await runCli(["--json", "--host", "test", "revision", "restore", "cli-draft", "2"], env);
      expect(JSON.parse(restoredRevision.stdout)).toMatchObject({ ok: true, data: { baseRevision: 1, hasUnsavedChanges: true, draft: { prompt: "revision second" } } });

      const capabilities = await runCli(["--json", "--host", "test", "capabilities"], env);
      expect(JSON.parse(capabilities.stdout)).toMatchObject({ ok: true, data: { format: "prompt-vault/capabilities/v1" } });
      expect(capabilities.stdout).not.toMatch(/branch|checkout|commit|working tree/i);
      const marked = await runCli(["--json", "--host", "test", "revision", "mark", "cli-draft", "2", "--favorite", "true"], env);
      const markedPayload = JSON.parse(marked.stdout);
      expect(markedPayload.ok).toBe(true);
      expect(markedPayload.data.revisions[0]).toMatchObject({ id: 2, favorite: true });
      const duplicated = await runCli(["--json", "--host", "test", "theme", "duplicate", "cli-draft"], env);
      const duplicateSlug = JSON.parse(duplicated.stdout).data.slug as string;
      expect(duplicateSlug).toMatch(/^cli-draft-/);
      expect(JSON.parse((await runCli(["--json", "--host", "test", "statistics"], env)).stdout)).toMatchObject({ ok: true, data: { themes: 3, revisions: 3 } });
      expect(JSON.parse((await runCli(["--json", "--host", "test", "workspace", "synchronize"], env)).stdout)).toMatchObject({ ok: true, data: { errors: { "broken-theme": expect.any(String) } } });
      expect(JSON.parse((await runCli(["--json", "--host", "test", "export"], env)).stdout)).toMatchObject({ ok: true, data: { format: "prompt-vault/themes/v2" } });
      expect((await runCli(["--json", "--host", "test", "theme", "delete", duplicateSlug], env)).code).toBe(0);
      expect((await runCli(["--json", "--host", "test", "revision", "delete", "cli-draft", "2"], env)).code).toBe(0);

      const hosts = await runCli(["--json", "host", "list"], env);
      expect(JSON.parse(hosts.stdout)).toEqual({
        ok: true,
        data: [{ name: "test", url: host, current: true, authenticated: true }],
      });

      const relogin = runCli(["--json", "auth", "login", "--host", host, "--name", "test", "--no-browser"], env);
      const replacement = await waitForPendingRequest(host, "host-token");
      expect((await fetch(`${host}/api/v2/auth/device/${replacement.requestId}/approve`, {
        method: "POST",
        headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: replacement.userCode }),
      })).status).toBe(204);
      expect((await relogin).code).toBe(0);
      const credentials = await fetch(`${host}/api/v2/auth/credentials`, {
        headers: { Authorization: "Bearer host-token" },
      });
      expect(await credentials.json()).toHaveLength(1);

      const concurrentLogins = ["alpha", "beta"].map((name) => runCli(
        ["--json", "auth", "login", "--host", host, "--name", name, "--no-browser"],
        env,
      ));
      const concurrentRequests = await waitForPendingRequests(host, "host-token", 2);
      await Promise.all(concurrentRequests.map((request) => fetch(`${host}/api/v2/auth/device/${request.requestId}/approve`, {
        method: "POST",
        headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: request.userCode }),
      })));
      expect((await Promise.all(concurrentLogins)).map((result) => result.code)).toEqual([0, 0]);
      const concurrentHosts = JSON.parse((await runCli(["--json", "host", "list"], env)).stdout).data;
      expect(concurrentHosts.map((entry: { name: string }) => entry.name)).toEqual(["alpha", "beta", "test"]);
      expect(concurrentHosts.filter((entry: { current: boolean }) => entry.current)).toHaveLength(1);
      expect((await runCli(["--json", "host", "use", "test"], env)).code).toBe(0);

      const blockedConfig = join(directory, "blocked-config");
      await writeFile(blockedConfig, "not a directory", "utf8");
      const failedLogin = runCli(["--json", "auth", "login", "--host", host, "--name", "unsaved", "--no-browser"], {
        ...env,
        PROMPT_VAULT_CONFIG_DIR: blockedConfig,
      });
      const unsavedRequest = await waitForPendingRequest(host, "host-token");
      expect((await fetch(`${host}/api/v2/auth/device/${unsavedRequest.requestId}/approve`, {
        method: "POST",
        headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: unsavedRequest.userCode }),
      })).status).toBe(204);
      const failedLoginResult = await failedLogin;
      expect(failedLoginResult.code).toBe(4);
      expect(failedLoginResult.stderr).toContain(`Open ${host}/auth/cli/`);
      expect(JSON.parse(failedLoginResult.stdout)).toMatchObject({ ok: false, error: { code: "CREDENTIAL_SAVE_FAILED_REVOKED" } });
      expect((await fetch(`${host}/api/v2/auth/device/${unsavedRequest.requestId}`)).status).toBe(404);
      const credentialsAfterFailedLogin = await fetch(`${host}/api/v2/auth/credentials`, {
        headers: { Authorization: "Bearer host-token" },
      });
      expect(await credentialsAfterFailedLogin.json()).toHaveLength(3);

      const logout = await runCli(["--json", "auth", "logout", "--host", "test"], env);
      expect(JSON.parse(logout.stdout)).toEqual({ ok: true, data: { host: "test", authenticated: false } });
      const afterLogout = await runCli(["--json", "--host", "test", "theme", "list"], env);
      expect(afterLogout.code).toBe(4);
      expect(JSON.parse(afterLogout.stdout)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
      expect((await runCli(["--json", "auth", "logout", "--host", "alpha"], env)).code).toBe(0);
      expect((await runCli(["--json", "auth", "logout", "--host", "beta"], env)).code).toBe(0);
    } finally {
      server.close();
    }
  }, 30_000);
});
