// @vitest-environment node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPromptVault } from "./prompt-vault.js";
import { addMalformedTheme, copyBranchWorkspace, copyLegacyWorkspace, emptyWorkspace, snapshotFiles } from "../test/workspace.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

describe("Prompt Vault application interface", () => {
  it("projects an existing Python workspace as a Draft and Revision lineage without mutating it", async () => {
    const workspace = await copyLegacyWorkspace();
    const before = await snapshotFiles(workspace);
    const vault = createPromptVault({ workspace });

    const themes = await vault.listThemes();
    const theme = await vault.getTheme("legacy-fixture");

    expect(themes).toEqual([{
      slug: "legacy-fixture",
      title: "Legacy Fixture",
      description: "Existing Python workspace",
      category: "Illustration",
      tags: ["legacy", "fixture"],
      starred: false,
      archived: false,
      updatedAt: "2026-07-27T23:00:16+08:00",
      baseRevision: 1,
      hasUnsavedChanges: false,
      revisionCount: 1,
    }]);
    expect(theme).toMatchObject({
      ...themes[0],
      referenceUrls: ["https://example.com/source"],
      draft: {
        prompt: "first prompt",
        negative: "bad anatomy",
        notes: "saved note",
        model: "Krea 2",
        params: "steps: 8",
        assets: { reference: [], result: [] },
      },
      revisions: [{
        id: 1,
        parentIds: [],
        note: "Initial revision",
        actor: "fixture",
        createdAt: "2026-07-27T23:00:16+08:00",
        digest: "4c78076e29a52f2e875f6194f8d6d99c427c875bd7dffe615f947c8211636b74",
        promptExcerpt: "first prompt",
        featured: false,
        favorite: false,
        hidden: false,
      }],
    });
    expect(await snapshotFiles(workspace)).toEqual(before);
    expect(await readdir(workspace)).not.toContain(".locks");
  });

  it("isolates malformed themes while listing valid themes", async () => {
    const workspace = await copyLegacyWorkspace();
    await addMalformedTheme(workspace);
    const vault = createPromptVault({ workspace });

    expect((await vault.listThemes()).map((theme) => theme.slug)).toEqual(["legacy-fixture"]);
    await expect(vault.getTheme("broken-theme")).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
  });

  it("preserves an explicitly null Base Revision", async () => {
    const workspace = await copyLegacyWorkspace();
    const refsPath = join(workspace, "legacy-fixture", "refs.json");
    const refs = JSON.parse(await readFile(refsPath, "utf8"));
    refs.working_base = null;
    await writeFile(refsPath, JSON.stringify(refs), "utf8");

    await expect(createPromptVault({ workspace }).getTheme("legacy-fixture")).resolves.toMatchObject({
      baseRevision: null,
      hasUnsavedChanges: true,
    });
  });

  it("reconstructs the Base Revision from a matching legacy branch head without writing refs", async () => {
    const workspace = await copyBranchWorkspace();
    const before = await snapshotFiles(workspace);

    const theme = await createPromptVault({ workspace }).getTheme("branch-fixture");

    expect(theme).toMatchObject({ baseRevision: 2, hasUnsavedChanges: false, revisionCount: 3 });
    expect(await snapshotFiles(workspace)).toEqual(before);
  });

  it("infers the previous Revision for legacy linear manifests without parent fields", async () => {
    const workspace = await copyBranchWorkspace();
    const manifestPath = join(workspace, "branch-fixture", "history", "0003", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.parent;
    delete manifest.parents;
    delete manifest.integrity;
    const texts = { prompt: "main prompt", negative: "", notes: "" };
    manifest.integrity = digest({ manifest, texts });
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const theme = await createPromptVault({ workspace }).getTheme("branch-fixture");

    expect(theme.revisions.find((revision) => revision.id === 3)?.parentIds).toEqual([2]);
  });

  it("rejects tampered immutable Revision provenance", async () => {
    const workspace = await copyLegacyWorkspace();
    const manifestPath = join(workspace, "legacy-fixture", "history", "0001", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.actor = "tampered";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(createPromptVault({ workspace }).getTheme("legacy-fixture")).rejects.toThrow(/provenance failed integrity verification/);
  });

  it("ignores unrelated filesystem entries and preserves legacy metadata fallbacks", async () => {
    const workspace = await copyLegacyWorkspace();
    await writeFile(join(workspace, "rogue-file"), "not a theme", "utf8");
    await mkdir(join(workspace, "not-a-theme"));
    const metadataPath = join(workspace, "legacy-fixture", "theme.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.title = "";
    delete metadata.category;
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");

    const themes = await createPromptVault({ workspace }).listThemes();

    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({ slug: "legacy-fixture", title: "legacy-fixture", category: "未分类" });
    await rm(join(workspace, "not-a-theme"), { recursive: true });
  });

  it("rejects Theme directory links that escape the workspace", async () => {
    const workspace = await copyLegacyWorkspace();
    const outsideTheme = join(workspace, "..", "outside-theme");
    await cp(join(workspace, "legacy-fixture"), outsideTheme, { recursive: true });
    await symlink(outsideTheme, join(workspace, "escaped-theme"), "junction");

    await expect(createPromptVault({ workspace }).getTheme("escaped-theme")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a Base Revision that does not exist", async () => {
    const workspace = await copyLegacyWorkspace();
    const refsPath = join(workspace, "legacy-fixture", "refs.json");
    const refs = JSON.parse(await readFile(refsPath, "utf8"));
    refs.working_base = 99;
    await writeFile(refsPath, JSON.stringify(refs), "utf8");

    await expect(createPromptVault({ workspace }).getTheme("legacy-fixture")).rejects.toThrow(/Base Revision 99 does not exist/);
  });

  it("creates and edits a Draft without creating a Revision", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });

    const created = await vault.createTheme({
      title: "Tea Party",
      description: "Initial archive",
      tags: ["tea", "anime"],
      prompt: "first draft",
      model: "Krea 2",
    });
    const updated = await vault.updateDraft(created.slug, {
      title: "Tea Party Study",
      prompt: "second draft",
      notes: "working notes",
      params: "steps: 8",
    });

    expect(created).toMatchObject({ slug: "tea-party", baseRevision: null, hasUnsavedChanges: true, revisionCount: 0 });
    expect(updated).toMatchObject({
      slug: "tea-party",
      title: "Tea Party Study",
      baseRevision: null,
      hasUnsavedChanges: true,
      revisionCount: 0,
      draft: { prompt: "second draft", notes: "working notes", model: "Krea 2", params: "steps: 8" },
    });
  });

  it("adds a valid image batch atomically, preserves order, and removes individual Assets", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Assets" });

    await expect(vault.addAssets(theme.slug, "result", [
      { name: "valid.png", content: png },
      { name: "broken.png", content: Buffer.from("not an image") },
    ])).rejects.toThrow(/valid png image/);
    expect((await vault.getTheme(theme.slug)).draft.assets.result).toEqual([]);

    const uploaded = await vault.addAssets(theme.slug, "result", [
      { name: "z-last.png", content: png },
      { name: "a-first.png", content: png },
    ]);
    expect(uploaded.draft.assets.result).toMatchObject([
      { name: "z-last.png", mime: "image/png" },
      { name: "a-first.png", mime: "image/png" },
    ]);
    await expect(vault.reorderAssets(theme.slug, "result", ["z-last.png"])).rejects.toThrow(/every current Asset exactly once/);
    expect((await vault.getTheme(theme.slug)).draft.assets.result.map((asset) => asset.name)).toEqual(["z-last.png", "a-first.png"]);
    const reordered = await vault.reorderAssets(theme.slug, "result", ["a-first.png", "z-last.png"]);
    expect(reordered.draft.assets.result.map((asset) => asset.name)).toEqual(["a-first.png", "z-last.png"]);
    const removed = await vault.removeAsset(theme.slug, "result", "a-first.png");
    expect(removed.draft.assets.result.map((asset) => asset.name)).toEqual(["z-last.png"]);

    const unrelated = join(workspace, theme.slug, "outputs", "metadata.txt");
    await writeFile(unrelated, "keep this", "utf8");
    await expect(vault.removeAsset(theme.slug, "result", "metadata.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await readFile(unrelated, "utf8")).toBe("keep this");

    const firstCaseVariant = await vault.addAssets(theme.slug, "result", [{ name: "Photo.png", content: png }]);
    const originalPhoto = firstCaseVariant.draft.assets.result.find((asset) => asset.name === "Photo.png");
    const secondCaseVariant = await vault.addAssets(theme.slug, "result", [{ name: "photo.png", content: Buffer.concat([png, Buffer.from("different")]) }]);
    const photoAssets = secondCaseVariant.draft.assets.result.filter((asset) => asset.name.toLocaleLowerCase().startsWith("photo"));
    expect(photoAssets).toHaveLength(2);
    expect(photoAssets.map((asset) => asset.name.toLocaleLowerCase())).not.toEqual(["photo.png", "photo.png"]);
    expect(photoAssets.find((asset) => asset.name === "Photo.png")?.sha256).toBe(originalPhoto?.sha256);
  });

  it("discards Draft changes by restoring the Base Revision", async () => {
    const workspace = await copyLegacyWorkspace();
    const themeDirectory = join(workspace, "legacy-fixture");
    const sha256 = createHash("sha256").update(png).digest("hex");
    await mkdir(join(workspace, ".assets", sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(workspace, ".assets", sha256.slice(0, 2), `${sha256}.png`), png);
    await mkdir(join(themeDirectory, "outputs"), { recursive: true });
    await writeFile(join(themeDirectory, "outputs", "baseline.png"), png);
    const manifestPath = join(themeDirectory, "history", "0001", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const texts = { prompt: "first prompt", negative: "bad anatomy", notes: "saved note" };
    manifest.assets.result = [{ name: "baseline.png", sha256, size: png.byteLength, mime: "image/png" }];
    manifest.digest = digest({ meta: manifest.meta, texts, assets: manifest.assets });
    delete manifest.integrity;
    manifest.integrity = digest({ manifest, texts });
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const sidecar = join(themeDirectory, "outputs", "generation.json");
    await writeFile(sidecar, "preserve me", "utf8");
    const vault = createPromptVault({ workspace });
    await vault.updateDraft("legacy-fixture", { prompt: "changed", model: "Other model" });
    await vault.addAssets("legacy-fixture", "result", [{ name: "temporary.png", content: png }]);

    const discarded = await vault.discardDraft("legacy-fixture");

    expect(discarded).toMatchObject({
      baseRevision: 1,
      hasUnsavedChanges: false,
      draft: { prompt: "first prompt", model: "Krea 2", assets: { result: [{ name: "baseline.png", sha256 }] } },
    });
    expect(await readFile(sidecar, "utf8")).toBe("preserve me");
  });

  it("discards an initial Draft while preserving Theme metadata", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Unsaved", description: "Keep me", prompt: "remove me", model: "Krea" });
    await vault.addAssets(theme.slug, "reference", [{ name: "temporary.png", content: png }]);

    const discarded = await vault.discardDraft(theme.slug);

    expect(discarded).toMatchObject({
      title: "Unsaved",
      description: "Keep me",
      baseRevision: null,
      hasUnsavedChanges: false,
      draft: { prompt: "", model: "", params: "", assets: { reference: [], result: [] } },
    });
  });

  it("does not rewrite a Draft that already matches its Base Revision", async () => {
    const workspace = await copyLegacyWorkspace();
    const before = await snapshotFiles(workspace);

    const discarded = await createPromptVault({ workspace }).discardDraft("legacy-fixture");

    expect(discarded.hasUnsavedChanges).toBe(false);
    expect(await snapshotFiles(workspace)).toEqual(before);
  });

  it("recovers an interrupted Theme transaction before serving readers", async () => {
    const workspace = await copyLegacyWorkspace();
    const themeDirectory = join(workspace, "legacy-fixture");
    const before = await snapshotFiles(workspace);
    const stagingName = ".staging-deadbeef";
    const backupName = ".backup-deadbeef";
    const staging = join(themeDirectory, stagingName);
    const backup = join(themeDirectory, backupName);
    await mkdir(staging);
    await mkdir(backup);
    await writeFile(join(staging, "theme.json"), "{}", "utf8");
    await writeFile(join(staging, "prompt.md"), "replacement", "utf8");
    await rename(join(themeDirectory, "theme.json"), join(backup, "theme.json"));
    await rename(join(staging, "theme.json"), join(themeDirectory, "theme.json"));
    await rename(join(themeDirectory, "prompt.md"), join(backup, "prompt.md"));
    await writeFile(join(themeDirectory, ".prompt-vault-transaction.json"), JSON.stringify({
      staging: stagingName,
      backup: backupName,
      names: ["theme.json", "prompt.md"],
      existed: ["theme.json", "prompt.md"],
      phase: "prepared",
    }), "utf8");

    const recovered = await createPromptVault({ workspace }).getTheme("legacy-fixture");

    expect(recovered.draft.prompt).toBe("first prompt");
    expect(await snapshotFiles(workspace)).toEqual(before);

    await writeFile(join(themeDirectory, ".prompt-vault-transaction.json"), JSON.stringify({
      staging: ".staging-feedface",
      backup: ".backup-feedface",
      names: ["theme.json", "prompt.md"],
      existed: ["theme.json", "prompt.md"],
      phase: "prepared",
    }), "utf8");
    expect((await createPromptVault({ workspace }).getTheme("legacy-fixture")).draft.prompt).toBe("first prompt");
    expect(await snapshotFiles(workspace)).toEqual(before);
  });

  it("saves immutable Revisions with content-addressed Assets and parent Lineage", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Lineage", prompt: "root prompt", model: "Krea" });
    await vault.addAssets(theme.slug, "result", [{ name: "root.png", content: png }]);

    const root = await vault.saveRevision(theme.slug, { note: "Root", actor: "test" });
    const rootRevision = await vault.getRevision(theme.slug, 1);
    expect(root).toMatchObject({ baseRevision: 1, hasUnsavedChanges: false, revisionCount: 1 });
    expect(rootRevision).toMatchObject({ id: 1, parentIds: [], note: "Root", actor: "test", draft: { prompt: "root prompt", assets: { result: [{ name: "root.png" }] } } });

    await vault.updateDraft(theme.slug, { prompt: "second prompt", model: "Flux" });
    const second = await vault.saveRevision(theme.slug, { note: "Second" });
    expect(second.revisions[0]).toMatchObject({ id: 2, parentIds: [1] });
    await vault.updateDraft(theme.slug, { prompt: "unpublished edit" });
    expect(await vault.getRevision(theme.slug, 2)).toMatchObject({ draft: { prompt: "second prompt", model: "Flux" } });

    const lineage = await vault.getLineage(theme.slug);
    expect(lineage.edges).toEqual([{ parentId: 1, childId: 2 }]);
    expect(lineage.revisions.map((revision) => revision.id)).toEqual([2, 1]);
  });

  it("continues from a Revision or restores its content without checkout concepts", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Directions", prompt: "root" });
    await vault.saveRevision(theme.slug, { note: "Root" });
    await vault.updateDraft(theme.slug, { prompt: "main second" });
    await vault.saveRevision(theme.slug, { note: "Main second" });
    const sidecar = join(workspace, theme.slug, "outputs", "generation.json");
    await writeFile(sidecar, "preserve me", "utf8");
    await vault.updateDraft(theme.slug, { prompt: "unsaved" });

    await expect(vault.continueFromRevision(theme.slug, 1)).rejects.toThrow(/unsaved Draft changes/);
    const continued = await vault.continueFromRevision(theme.slug, 1, { force: true });
    expect(continued).toMatchObject({ baseRevision: 1, hasUnsavedChanges: false, draft: { prompt: "root" } });
    expect(await readFile(sidecar, "utf8")).toBe("preserve me");
    await vault.updateDraft(theme.slug, { prompt: "forked direction" });
    const fork = await vault.saveRevision(theme.slug, { note: "Fork" });
    expect(fork.revisions[0]).toMatchObject({ id: 3, parentIds: [1] });

    const restored = await vault.restoreRevision(theme.slug, 2);
    expect(restored).toMatchObject({ baseRevision: 3, hasUnsavedChanges: true, draft: { prompt: "main second" } });
    const merged = await vault.saveRevision(theme.slug, { note: "Merge", parentIds: [2, 3] });
    expect(merged.revisions[0]).toMatchObject({ id: 4, parentIds: [2, 3] });
  });

  it("compares immutable Revision text, metadata, and Assets", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Compare", prompt: "first prompt" });
    await vault.addAssets(theme.slug, "reference", [
      { name: "source.png", content: png },
      { name: "detail.png", content: png },
    ]);
    await vault.saveRevision(theme.slug, { note: "First" });
    await vault.updateDraft(theme.slug, { prompt: "second prompt", model: "Flux" });
    await vault.removeAsset(theme.slug, "reference", "source.png");
    await vault.reorderAssets(theme.slug, "reference", ["detail.png"]);
    await vault.saveRevision(theme.slug, { note: "Second" });

    const comparison = await vault.compareRevisions(theme.slug, 1, 2);

    expect(comparison.diffs.prompt).toContain("-first prompt");
    expect(comparison.diffs.prompt).toContain("+second prompt");
    expect(comparison.metadataChanges).toEqual([{ field: "model", left: "", right: "Flux" }]);
    expect(comparison.assetChanges.reference).toMatchObject({
      removed: [{ name: "source.png" }],
      added: [],
      orderChanged: true,
      leftOrder: ["source.png", "detail.png"],
      rightOrder: ["detail.png"],
    });
  });

  it("retains Theme duplication, archive metadata, statistics, export, and workspace synchronization", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const source = await vault.createTheme({ title: "Managed", prompt: "root", starred: true });
    await vault.addAssets(source.slug, "result", [{ name: "result.png", content: png }]);
    await writeFile(join(workspace, source.slug, "outputs", "generation.json"), "preserve sidecar", "utf8");
    await vault.saveRevision(source.slug, { note: "Root" });

    const duplicate = await vault.duplicateTheme(source.slug);
    expect(duplicate).toMatchObject({
      title: "Managed 副本",
      starred: false,
      archived: false,
      baseRevision: null,
      revisionCount: 0,
      draft: { prompt: "root", assets: { result: [{ name: "result.png" }] } },
    });
    expect(await readFile(join(workspace, duplicate.slug, "outputs", "generation.json"), "utf8")).toBe("preserve sidecar");

    await vault.updateDraft(source.slug, { archived: true, prompt: "unsaved" });
    expect(await vault.getStatistics()).toEqual({
      themes: 2,
      active: 1,
      archived: 1,
      starred: 1,
      revisions: 1,
      references: 0,
      results: 2,
    });
    expect(await vault.synchronizeWorkspace()).toEqual({
      unsavedThemes: [source.slug, duplicate.slug],
      count: 2,
      errors: {},
    });
    const exported = await vault.exportVault();
    expect(exported.format).toBe("prompt-vault/themes/v2");
    expect(exported.themes.map((theme) => theme.slug)).toEqual([source.slug, duplicate.slug]);

    await vault.deleteTheme(duplicate.slug);
    await expect(vault.getTheme(duplicate.slug)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await readdir(join(workspace, ".trash"))).some((name) => name.startsWith(`${duplicate.slug}-`))).toBe(true);
  });

  it("marks Revisions and only permanently deletes leaves", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Safe deletion", prompt: "root" });
    await vault.saveRevision(theme.slug, { note: "Root" });
    await vault.updateDraft(theme.slug, { prompt: "child" });
    await vault.saveRevision(theme.slug, { note: "Child" });

    const marked = await vault.setRevisionMarks(theme.slug, 2, { featured: true, favorite: true, hidden: false });
    expect(marked.revisions[0]).toMatchObject({ id: 2, featured: true, favorite: true, hidden: false });
    await expect(vault.setRevisionMarks(theme.slug, 2, {})).rejects.toThrow(/at least one Revision mark/);
    await expect(vault.deleteRevision(theme.slug, 1)).rejects.toThrow(/descendants/);

    const deleted = await vault.deleteRevision(theme.slug, 2);
    expect(deleted).toMatchObject({ baseRevision: 1, revisionCount: 1, hasUnsavedChanges: false, draft: { prompt: "root" } });
    expect(deleted.revisions[0]).toMatchObject({ id: 1 });
  });

  it("describes every supported mutation without removed source-control concepts", () => {
    const capabilities = createPromptVault({ workspace: "unused" }).getCapabilities();
    expect(capabilities.mutations.map((mutation) => mutation.name)).toEqual([
      "createTheme", "updateDraft", "applyDraftEdit", "discardDraft", "addAssets", "reorderAssets", "removeAsset",
      "saveRevision", "overwriteRevision", "continueFromRevision", "restoreRevision", "setNodeTitle", "setRevisionMarks", "deleteRevision",
      "duplicateTheme", "deleteTheme",
    ]);
    expect(JSON.stringify(capabilities)).not.toMatch(/branch|checkout|commit|working tree/i);
    expect(capabilities.mutations.find((mutation) => mutation.name === "deleteRevision")?.safety).toMatch(/leaf/i);
  });

  it("applies a complete editor save atomically", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Atomic editor", prompt: "root" });
    await vault.addAssets(theme.slug, "reference", [{ name: "old.png", content: png }]);
    await vault.saveRevision(theme.slug, { note: "Root" });
    const before = await snapshotFiles(workspace);

    await expect(vault.applyDraftEdit(theme.slug, {
      sourceRevisionId: 1,
      update: { prompt: "must roll back" },
      assets: { result: { uploads: [{ name: "broken.png", content: Buffer.from("not an image") }] } },
      saveRevision: { note: "Broken" },
    })).rejects.toThrow(/valid png image/);
    expect(await snapshotFiles(workspace)).toEqual(before);

    const variant = Buffer.concat([png, Buffer.from("valid variant")]);
    const variantDigest = createHash("sha256").update(variant).digest("hex");
    const corruptDirectory = join(workspace, ".assets", variantDigest.slice(0, 2));
    await mkdir(corruptDirectory, { recursive: true });
    await writeFile(join(corruptDirectory, `${variantDigest}.png`), "corrupt", "utf8");
    await expect(vault.applyDraftEdit(theme.slug, {
      update: { prompt: "must also roll back" },
      assets: { result: { uploads: [{ name: "variant.png", content: variant }] } },
      saveRevision: { note: "Corrupt blob" },
    })).rejects.toThrow(/stored Asset failed integrity verification/);
    expect(await vault.getTheme(theme.slug)).toMatchObject({ baseRevision: 1, revisionCount: 1, draft: { prompt: "root" } });

    const saved = await vault.applyDraftEdit(theme.slug, {
      sourceRevisionId: 1,
      update: { prompt: "child", model: "Flux" },
      assets: {
        reference: { remove: ["old.png"], order: [] },
        result: { uploads: [{ name: "new.png", content: png }], order: [{ source: "upload", index: 0 }] },
      },
      saveRevision: { note: "Child", parentIds: [1], actor: "test" },
    });
    expect(saved).toMatchObject({
      baseRevision: 2,
      hasUnsavedChanges: false,
      revisionCount: 2,
      draft: { prompt: "child", model: "Flux", assets: { reference: [], result: [{ name: "new.png" }] } },
    });
    expect(saved.revisions[0]).toMatchObject({ id: 2, note: "Child", parentIds: [1] });
  });

  it("overwrites an ancestor without changing the current node and rolls back invalid edits", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Ancestor overwrite", prompt: "root" });
    await vault.saveRevision(theme.slug, { note: "Root" });
    await vault.updateDraft(theme.slug, { prompt: "child" });
    await vault.saveRevision(theme.slug, { note: "Child" });
    await vault.updateDraft(theme.slug, { prompt: "unrelated unsaved work" });
    const before = await snapshotFiles(workspace);

    await expect(vault.overwriteRevision(theme.slug, 1, {
      update: { prompt: "must roll back" },
      assets: { result: { uploads: [{ name: "broken.png", content: Buffer.from("not an image") }] } },
    })).rejects.toThrow(/valid png image/);
    expect(await snapshotFiles(workspace)).toEqual(before);

    const overwritten = await vault.overwriteRevision(theme.slug, 1, {
      note: "Updated root",
      update: { prompt: "root updated" },
    });

    expect(overwritten).toMatchObject({
      baseRevision: 2,
      revisionCount: 2,
      hasUnsavedChanges: true,
      draft: { prompt: "unrelated unsaved work" },
    });
    expect(overwritten.revisions.find((revision) => revision.id === 1)).toMatchObject({
      id: 1,
      note: "Updated root",
      parentIds: [],
    });
    expect(overwritten.revisions.find((revision) => revision.id === 2)).toMatchObject({
      id: 2,
      parentIds: [1],
    });
    expect((await vault.getRevision(theme.slug, 1)).draft.prompt).toBe("root updated");
  });

  it("atomically edits readable legacy Themes that omit optional managed files", async () => {
    const workspace = await emptyWorkspace();
    const vault = createPromptVault({ workspace });
    const theme = await vault.createTheme({ title: "Sparse", prompt: "before" });
    for (const name of ["refs.json", "references", "outputs", "history"]) {
      await rm(join(workspace, theme.slug, name), { recursive: true, force: true });
    }

    const updated = await vault.applyDraftEdit(theme.slug, { update: { prompt: "after" } });

    expect(updated).toMatchObject({ baseRevision: null, revisionCount: 0, draft: { prompt: "after", assets: { reference: [], result: [] } } });
  });
});
