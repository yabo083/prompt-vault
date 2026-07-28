import { readFileSync } from "node:fs";

function readVersion() {
  for (const relativePath of ["../../package.json"]) {
    try {
      return (JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as { version: string }).version;
    } catch {
      // The package manifest sits above dist/ in both source and published layouts.
    }
  }
  return "0.0.0";
}

export const VERSION = readVersion();
