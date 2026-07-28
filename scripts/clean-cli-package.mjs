import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await Promise.all([
  rm(resolve(root, "packages/cli/dist"), { recursive: true, force: true }),
  rm(resolve(root, "packages/cli/static"), { recursive: true, force: true }),
  rm(resolve(root, "packages/cli/LICENSE"), { force: true }),
]);
