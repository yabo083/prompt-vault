import { cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtureRoot = resolve("tests/fixtures/legacy-workspace");
const branchFixtureRoot = resolve("tests/fixtures/branch-workspace");

export async function copyLegacyWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "prompt-vault-ts-"));
  const workspace = join(root, "workspace");
  await cp(fixtureRoot, workspace, { recursive: true });
  for (const directory of ["legacy-fixture", "legacy-fixture/history/0001"]) {
    await writeFile(join(workspace, directory, "prompt.md"), "first prompt", "utf8");
    await writeFile(join(workspace, directory, "negative.md"), "bad anatomy", "utf8");
    await writeFile(join(workspace, directory, "notes.md"), "saved note", "utf8");
  }
  return workspace;
}

export async function emptyWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "prompt-vault-ts-empty-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return workspace;
}

export async function addMalformedTheme(workspace: string) {
  const theme = join(workspace, "broken-theme");
  await cp(join(fixtureRoot, "legacy-fixture"), theme, { recursive: true });
  await writeFile(join(theme, "theme.json"), "[]", "utf8");
}

export async function copyBranchWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "prompt-vault-ts-branch-"));
  const workspace = join(root, "workspace");
  await cp(branchFixtureRoot, workspace, { recursive: true });
  await writeFile(join(workspace, "branch-fixture", "prompt.md"), "feature prompt", "utf8");
  for (const [revision, prompt] of [["0001", "base prompt"], ["0002", "feature prompt"], ["0003", "main prompt"]]) {
    await writeFile(join(workspace, "branch-fixture", "history", revision, "prompt.md"), prompt, "utf8");
  }
  return workspace;
}

export async function snapshotFiles(root: string) {
  const records: Array<[string, string]> = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await stat(path);
      if (info.isDirectory()) await visit(path);
      else records.push([path.slice(root.length + 1).replaceAll("\\", "/"), await readFile(path, "base64")]);
    }
  }
  await visit(root);
  return records;
}
