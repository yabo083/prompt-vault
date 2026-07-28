import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageStatic = resolve(root, "packages/cli/static");
await rm(packageStatic, { recursive: true, force: true });
await mkdir(packageStatic, { recursive: true });
await cp(resolve(root, "static/dist"), resolve(packageStatic, "dist"), { recursive: true });
await copyFile(resolve(root, "LICENSE"), resolve(root, "packages/cli/LICENSE"));
