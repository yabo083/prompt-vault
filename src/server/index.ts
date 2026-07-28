import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startVaultHost } from "./host.js";

const port = Number(process.env.PORT || 8768);
const hostname = process.env.HOST || "127.0.0.1";
const publicHostname = hostname === "0.0.0.0"
  ? "127.0.0.1"
  : hostname === "::"
    ? "[::1]"
    : hostname.includes(":")
      ? `[${hostname}]`
      : hostname;
const publicOrigin = process.env.PROMPT_VAULT_PUBLIC_URL || `http://${publicHostname}:${port}`;
const running = await startVaultHost({
  workspace: resolve(process.env.PROMPT_VAULT_WORKSPACE || "workspace"),
  tokenFile: resolve(process.env.PROMPT_VAULT_TOKEN_FILE || ".vault-token"),
  credentialDirectory: resolve(process.env.PROMPT_VAULT_CREDENTIAL_DIRECTORY || ".vault-auth"),
  browserSessionDirectory: resolve(process.env.PROMPT_VAULT_BROWSER_SESSION_DIRECTORY || ".browser-sessions"),
  staticDirectory: process.env.PROMPT_VAULT_STATIC_DIRECTORY
    ? resolve(process.env.PROMPT_VAULT_STATIC_DIRECTORY)
    : fileURLToPath(new URL("../../static/dist/", import.meta.url)),
  hostname,
  port,
  publicOrigin,
  trustedProxies: (process.env.PROMPT_VAULT_TRUSTED_PROXIES || "").split(",").map((address) => address.trim()).filter(Boolean),
  instanceId: process.env.PROMPT_VAULT_INSTANCE_ID,
});

console.log(`Prompt Vault Host ${running.version} listening on ${running.publicOrigin}`);

let closing = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (closing) process.exit(signal === "SIGINT" ? 130 : 143);
  closing = true;
  await running.close();
  process.exitCode = signal === "SIGINT" ? 130 : 143;
};
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
