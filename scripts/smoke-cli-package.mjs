import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "prompt-vault-package-smoke-"));
const packDirectory = join(temporary, "package");
const installDirectory = join(temporary, "install");
const dataDirectory = join(temporary, "Prompt Vault Data");
const configDirectory = join(temporary, "config");
const tarballArgument = process.argv.indexOf("--tarball");
const suppliedTarball = tarballArgument === -1 ? null : process.argv[tarballArgument + 1];
if (tarballArgument !== -1 && !suppliedTarball) throw new Error("--tarball requires a path");
const npm = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32" ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] : [];

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})\n${result.error || ""}\n${result.stdout || ""}\n${result.stderr || ""}`);
  return result;
}

await Promise.all([mkdir(packDirectory), mkdir(installDirectory)]);
let child;
try {
  let tarball = suppliedTarball ? resolve(suppliedTarball) : null;
  if (!tarball) {
    run(npm, [...npmPrefix, "pack", "--workspace", "@miyako-lab/prompt-vault-cli", "--pack-destination", packDirectory]);
    const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`Expected one package tarball, found ${tarballs.length}`);
    tarball = join(packDirectory, tarballs[0]);
  }
  run(npm, [...npmPrefix, "install", "--prefix", installDirectory, tarball]);
  const cli = join(installDirectory, "node_modules", "@miyako-lab", "prompt-vault-cli", "dist", "cli", "index.js");
  const env = { ...process.env, PROMPT_VAULT_CONFIG_DIR: configDirectory, PROMPT_VAULT_CREDENTIAL_STORE: "file" };
  const port = await unusedPort();
  run(process.execPath, [cli, "init", "--directory", dataDirectory, "--port", String(port)], { env });
  child = spawn(process.execPath, [cli, "serve", "--directory", dataDirectory, "--name", "packed", "--no-browser"], {
    cwd: temporary,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const ready = await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Packaged Host did not become ready\n${stderr}`)), 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(stdout.slice(0, newline)));
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Packaged Host exited before readiness (${code})\n${stderr}`)));
  });
  if (ready?.data?.state !== "serving") throw new Error(`Unexpected readiness output: ${JSON.stringify(ready)}`);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  if (!page.ok || !(await page.text()).includes("id=\"root\"")) throw new Error("Packaged Web UI was not served");
  const themes = run(process.execPath, [cli, "theme", "list"], { env });
  const payload = JSON.parse(themes.stdout);
  if (!payload.ok || !Array.isArray(payload.data)) throw new Error(`Packaged CLI query failed: ${themes.stdout}`);
  process.stdout.write(`${JSON.stringify({ ok: true, platform: process.platform, version: ready.data.version })}\n`);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "close"), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000))]);
  }
  await rm(temporary, { recursive: true, force: true });
}
