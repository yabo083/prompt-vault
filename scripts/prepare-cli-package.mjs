import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await copyFile(resolve(root, "LICENSE"), resolve(root, "packages/cli/LICENSE"));
