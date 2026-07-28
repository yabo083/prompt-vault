import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { createAuthorizationStore } from "../core/authorization.js";
import { createPromptVault } from "../core/prompt-vault.js";
import { createHttpApp } from "./app.js";
import { loadOrCreateHostToken } from "./token.js";

const port = Number(process.env.PORT || 8768);
const hostname = process.env.HOST || "127.0.0.1";
const workspace = process.env.PROMPT_VAULT_WORKSPACE || "workspace";
const token = await loadOrCreateHostToken({
  tokenFile: resolve(process.env.PROMPT_VAULT_TOKEN_FILE || ".vault-token"),
  envToken: process.env.PROMPT_VAULT_TOKEN,
});
const authorization = await createAuthorizationStore({
  credentialDirectory: resolve(process.env.PROMPT_VAULT_CREDENTIAL_DIRECTORY || ".vault-auth"),
});
const app = createHttpApp({
  vault: createPromptVault({ workspace }),
  token,
  authorization,
  publicOrigin: process.env.PROMPT_VAULT_PUBLIC_URL,
  trustedProxies: (process.env.PROMPT_VAULT_TRUSTED_PROXIES || "").split(",").map((address) => address.trim()).filter(Boolean),
  staticDirectory: resolve(process.env.PROMPT_VAULT_STATIC_DIRECTORY || "static/dist"),
});

serve({ fetch: app.fetch, port, hostname }, ({ port: listeningPort }) => {
  console.log(`Prompt Vault TypeScript host listening on http://${hostname}:${listeningPort}`);
});
