import { readFileSync } from "node:fs";

function readVersion() {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export const HOST_VERSION = readVersion();
