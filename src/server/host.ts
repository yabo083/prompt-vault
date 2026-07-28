import { serve } from "@hono/node-server";
import { createAuthorizationStore } from "../core/authorization.js";
import { createPromptVault } from "../core/prompt-vault.js";
import { createHttpApp } from "./app.js";
import { createBrowserSessionStore } from "./browser-sessions.js";
import { loadOrCreateHostToken } from "./token.js";
import { createLocalLaunchAuthorization } from "./local-launch.js";
import { HOST_VERSION } from "./version.js";

export type StartVaultHostOptions = {
  workspace: string;
  tokenFile: string;
  credentialDirectory: string;
  browserSessionDirectory: string;
  staticDirectory: string;
  hostname: string;
  port: number;
  publicOrigin: string;
  trustedProxies?: string[];
  instanceId?: string;
  localCredentialLabel?: string;
  enableLocalBrowserLaunch?: boolean;
};

function displayHost(hostname: string) {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function canonicalOrigin(value: string) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Prompt Vault publicOrigin must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  }
  return url.origin;
}

export async function startVaultHost(options: StartVaultHostOptions) {
  const publicOrigin = canonicalOrigin(options.publicOrigin);
  const token = await loadOrCreateHostToken({ tokenFile: options.tokenFile });
  const authorization = await createAuthorizationStore({ credentialDirectory: options.credentialDirectory });
  const launch = options.enableLocalBrowserLaunch && options.instanceId
    ? createLocalLaunchAuthorization({ origin: publicOrigin, instanceId: options.instanceId })
    : null;
  const app = createHttpApp({
    vault: createPromptVault({ workspace: options.workspace }),
    token,
    authorization,
    browserSessions: createBrowserSessionStore({ directory: options.browserSessionDirectory }),
    localLaunch: launch?.authorization,
    publicOrigin,
    trustedProxies: options.trustedProxies,
    staticDirectory: options.staticDirectory,
    instanceId: options.instanceId,
    version: HOST_VERSION,
  });

  let server!: ReturnType<typeof serve>;
  let rejectListening!: (error: unknown) => void;
  const onError = (error: unknown) => rejectListening(error);
  const listening = new Promise<{ port: number }>((resolve, reject) => {
    rejectListening = reject;
    server = serve({ fetch: app.fetch, port: options.port, hostname: options.hostname }, ({ port }) => resolve({ port }));
    server.once("error", onError);
  });
  let bound: { port: number };
  try {
    bound = await listening;
  } catch (error) {
    server?.close();
    throw error;
  }
  server.removeListener("error", onError);
  let localCredential = null;
  try {
    localCredential = options.localCredentialLabel ? await authorization.issueCredential(options.localCredentialLabel) : null;
  } catch (error) {
    server.close();
    throw error;
  }
  let closed = false;

  return {
    url: `http://${displayHost(options.hostname)}:${bound.port}`,
    publicOrigin,
    instanceId: options.instanceId || null,
    version: HOST_VERSION,
    localCredential,
    launchUrl: launch ? `${publicOrigin}/#launch=${launch.nonce}` : null,
    async close(timeoutMs = 5_000) {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if ("closeAllConnections" in server) server.closeAllConnections();
          resolve();
        }, timeoutMs);
        timeout.unref();
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}
