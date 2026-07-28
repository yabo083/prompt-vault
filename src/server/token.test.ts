// @vitest-environment node

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateHostToken } from "./token.js";

describe("Vault Host token", () => {
  it("reuses the existing host token instead of disabling authentication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-token-"));
    const tokenFile = join(directory, ".vault-token");
    await writeFile(tokenFile, "existing-token\n", "utf8");

    expect(await loadOrCreateHostToken({ tokenFile })).toBe("existing-token");
    expect(await readFile(tokenFile, "utf8")).toBe("existing-token\n");
  });

  it("creates a non-empty host token when no environment or file token exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-vault-token-"));
    const tokenFile = join(directory, ".vault-token");

    const token = await loadOrCreateHostToken({ tokenFile });

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect((await readFile(tokenFile, "utf8")).trim()).toBe(token);
  });
});
