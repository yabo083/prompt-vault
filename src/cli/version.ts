import { readFileSync } from "node:fs";

function readVersion() {
  for (const relativePath of ["../package.json", "../../packages/cli/package.json"]) {
    try {
      return (JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as { version: string }).version;
    } catch {
      // The first path is for the built package; the second is for source execution.
    }
  }
  return "0.0.0";
}

export const VERSION = readVersion();
