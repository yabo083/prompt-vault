import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTwoFilesPatch } from "diff";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type { ApplyDraftEditInput, AssetContent, AssetGroups, AssetKind, AssetUpload, DeleteRevisionOptions, Draft, DraftUpdate, Lineage, OverwriteRevisionInput, PromptVault, ReplaceDraftOptions, Revision, RevisionComparison, RevisionMarks, RevisionSummary, SaveRevisionInput, Theme, ThemeInput, ThemeSummary, VaultCapabilities, VaultExport, VaultStatistics, WorkspaceSynchronization } from "./types.js";
import { VaultError } from "./types.js";

const safeSlug = /^[\p{L}\p{N}_\u4e00-\u9fff-]{1,64}$/u;
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
const textFiles = { prompt: "prompt.md", negative: "negative.md", notes: "notes.md" } as const;
const assetDirectories: Record<AssetKind, string> = { reference: "references", result: "outputs" };
const transactionFilename = ".prompt-vault-transaction.json";
const assetOrderSchema = z.object({
  reference: z.array(z.string()).optional(),
  result: z.array(z.string()).optional(),
}).optional();

const themeMetaSchema = z.object({
  title: z.unknown().optional(),
  description: z.unknown().optional(),
  category: z.unknown().optional(),
  tags: z.unknown().optional(),
  starred: z.unknown().optional(),
  archived: z.unknown().optional(),
  model: z.unknown().optional(),
  params: z.unknown().optional(),
  reference_urls: z.unknown().optional(),
  asset_order: assetOrderSchema,
  updated_at: z.unknown().optional(),
}).passthrough();

const refsSchema = z.object({
  current_branch: z.string().optional(),
  branches: z.record(z.string(), z.number().int().positive().nullable()).optional(),
  working_base: z.number().int().positive().nullable().optional(),
  featured_commits: z.array(z.number().int().positive()).optional(),
  favorite_commits: z.array(z.number().int().positive()).optional(),
  hidden_commits: z.array(z.number().int().positive()).optional(),
  working_title: z.string().optional(),
  revision_titles: z.record(z.string(), z.string()).optional(),
  next_version: z.number().int().positive().optional(),
  tags: z.record(z.string(), z.number().int().positive()).optional(),
}).passthrough();

const manifestSchema = z.object({
  version: z.number().int().positive().optional(),
  parent: z.number().int().positive().nullable().optional(),
  parents: z.array(z.number().int().positive()).optional(),
  digest: z.string().default(""),
  created_at: z.string().default(""),
  actor: z.string().default(""),
  change_note: z.string().default(""),
  branch: z.string().optional(),
  meta: z.object({ model: z.unknown().optional(), params: z.unknown().optional() }).passthrough().default({}),
  assets: z.object({
    reference: z.array(z.object({ name: z.string(), sha256: z.string(), size: z.number().optional(), mime: z.string().optional() }).passthrough()).default([]),
    result: z.array(z.object({ name: z.string(), sha256: z.string(), size: z.number().optional(), mime: z.string().optional() }).passthrough()).default([]),
  }).default({ reference: [], result: [] }),
  integrity: z.string().optional(),
}).passthrough();

const transactionSchema = z.object({
  staging: z.string().regex(/^\.[A-Za-z0-9-]+$/),
  backup: z.string().regex(/^\.backup-[a-f0-9]+$/),
  names: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).min(1),
  existed: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)),
  phase: z.enum(["prepared", "installed"]),
});

function stringValue(value: unknown, fallback = "") {
  return value == null ? fallback : String(value);
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (typeof value === "string") return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  return [];
}

function referenceUrlArray(value: unknown) {
  return stringArray(value).filter((entry) => {
    try {
      return new Set(["http:", "https:"]).has(new URL(entry).protocol);
    } catch {
      return false;
    }
  });
}

async function readJson(path: string, schema: z.ZodType) {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return schema.parse(value);
  } catch (error) {
    throw new VaultError("INVALID_WORKSPACE", `Invalid workspace file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readOptionalJson(path: string, schema: z.ZodType) {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return schema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new VaultError("INVALID_WORKSPACE", `Invalid workspace file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readText(directory: string, filename: string) {
  try {
    return await readFile(join(directory, filename), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function readTexts(directory: string) {
  return {
    prompt: await readText(directory, textFiles.prompt),
    negative: await readText(directory, textFiles.negative),
    notes: await readText(directory, textFiles.notes),
  };
}

function mimeFor(name: string) {
  const extension = extname(name).toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

async function readAssets(themeDirectory: string, order?: z.infer<typeof assetOrderSchema>): Promise<AssetGroups> {
  const groups: AssetGroups = { reference: [], result: [] };
  for (const kind of Object.keys(assetDirectories) as AssetKind[]) {
    const directory = join(themeDirectory, assetDirectories[kind]);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const records = [];
    for (const name of names.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))) {
      if (!imageExtensions.has(extname(name).toLowerCase())) continue;
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const content = await readFile(path);
      records.push({
        name,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: info.size,
        mime: mimeFor(name),
      });
    }
    const byName = new Map(records.map((asset) => [asset.name, asset]));
    for (const name of order?.[kind] ?? []) {
      const asset = byName.get(name);
      if (!asset) continue;
      groups[kind].push(asset);
      byName.delete(name);
    }
    groups[kind].push(...byName.values());
  }
  return groups;
}

function creativeState(draft: Draft) {
  return JSON.stringify({
    prompt: draft.prompt,
    negative: draft.negative,
    notes: draft.notes,
    model: draft.model,
    params: draft.params,
    assets: draft.assets,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function revisionDirectories(themeDirectory: string) {
  const history = join(themeDirectory, "history");
  try {
    const names = await readdir(history);
    return names.filter((name) => /^\d+$/.test(name)).sort((left, right) => Number(left) - Number(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRevision(themeDirectory: string, directoryName: string, previousId: number | null) {
  const directory = join(themeDirectory, "history", directoryName);
  const manifest = manifestSchema.parse(await readJson(join(directory, "manifest.json"), manifestSchema));
  const texts = await readTexts(directory);
  const id = manifest.version ?? Number(directoryName);
  const expectedDigest = canonicalDigest({ meta: manifest.meta, texts, assets: manifest.assets });
  if (manifest.digest !== expectedDigest) {
    throw new VaultError("INVALID_WORKSPACE", `history revision ${id} failed integrity verification`);
  }
  const protectedManifest = { ...manifest } as Record<string, unknown>;
  delete protectedManifest.integrity;
  if (!manifest.integrity || manifest.integrity !== canonicalDigest({ manifest: protectedManifest, texts })) {
    throw new VaultError("INVALID_WORKSPACE", `history revision ${id} provenance failed integrity verification`);
  }
  const parentIds = Object.hasOwn(manifest, "parents")
    ? manifest.parents ?? []
    : Object.hasOwn(manifest, "parent")
      ? manifest.parent == null ? [] : [manifest.parent]
      : previousId == null ? [] : [previousId];
  return {
    manifest,
    draft: {
      ...texts,
      model: stringValue(manifest.meta.model),
      params: stringValue(manifest.meta.params),
      assets: manifest.assets as AssetGroups,
    } satisfies Draft,
    summary: {
      id,
      parentIds,
      note: manifest.change_note,
      actor: manifest.actor,
      createdAt: manifest.created_at,
      digest: manifest.digest,
      promptExcerpt: texts.prompt.slice(0, 180),
    },
  };
}

async function readAllRevisions(themeDirectory: string) {
  const records: Awaited<ReturnType<typeof readRevision>>[] = [];
  let previousId: number | null = null;
  for (const name of await revisionDirectories(themeDirectory)) {
    const revision = await readRevision(themeDirectory, name, previousId);
    records.push(revision);
    previousId = revision.summary.id;
  }
  return records;
}

function timestamp() {
  return new Date().toISOString();
}

function slugify(value: string) {
  const normalized = (value || "theme").normalize("NFKC").trim().toLocaleLowerCase();
  const slug = normalized.replace(/[^\p{L}\p{N}_\u4e00-\u9fff]+/gu, "-").replace(/^[-_]+|[-_]+$/g, "");
  return slug.slice(0, 64) || "theme";
}

async function withWorkspaceLock<T>(workspaceRoot: string, name: string, operation: () => Promise<T>) {
  const lockDirectory = join(tmpdir(), "prompt-vault-locks", createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 24));
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(join(lockDirectory, name), {
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 120, factor: 1.2, minTimeout: 10, maxTimeout: 250 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function recoverThemeTransaction(themeDirectory: string) {
  const journalPath = join(themeDirectory, transactionFilename);
  const journal = await readOptionalJson(journalPath, transactionSchema) as z.infer<typeof transactionSchema> | null;
  if (!journal) return;
  const staging = join(themeDirectory, journal.staging);
  const backup = join(themeDirectory, journal.backup);
  if (journal.phase === "prepared") {
    for (const name of [...journal.names].reverse()) {
      const live = join(themeDirectory, name);
      const staged = join(staging, name);
      const saved = join(backup, name);
      if (await pathExists(saved)) {
        await rm(live, { recursive: true, force: true });
        await rename(saved, live);
      } else if (!journal.existed.includes(name) && !(await pathExists(staged))) {
        await rm(live, { recursive: true, force: true });
      }
    }
  }
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await unlink(journalPath);
}

async function installStagedEntries(themeDirectory: string, staging: string, names: string[]) {
  const backup = join(themeDirectory, `.backup-${randomBytes(8).toString("hex")}`);
  const journalPath = join(themeDirectory, transactionFilename);
  let journal = { staging: basename(staging), backup: basename(backup), names, existed: [] as string[], phase: "prepared" as const };
  const backedUp: string[] = [];
  const installed: string[] = [];
  try {
    await mkdir(backup);
    const existed = [];
    for (const name of names) if (await pathExists(join(themeDirectory, name))) existed.push(name);
    journal = { ...journal, existed };
    await atomicJson(journalPath, journal);
    for (const name of names) {
      try {
        await rename(join(themeDirectory, name), join(backup, name));
        backedUp.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const name of names) {
      await rename(join(staging, name), join(themeDirectory, name));
      installed.push(name);
    }
    await atomicJson(journalPath, { ...journal, phase: "installed" });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const name of installed.reverse()) {
      try {
        await rm(join(themeDirectory, name), { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const name of backedUp.reverse()) {
      try {
        await rename(join(backup, name), join(themeDirectory, name));
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], `Failed to install and restore Theme files; recovery backup retained at ${backup}`);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await unlink(journalPath).catch(() => undefined);
    throw error;
  }
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  await unlink(journalPath).catch(() => undefined);
}

async function replaceThemeFiles(themeDirectory: string, files: Record<string, string>) {
  const staging = join(themeDirectory, `.staging-${randomBytes(8).toString("hex")}`);
  await mkdir(staging);
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(staging, name), content, "utf8");
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await installStagedEntries(themeDirectory, staging, Object.keys(files));
}

async function copyAssetDirectory(themeDirectory: string, kind: AssetKind, staging: string) {
  const directoryName = assetDirectories[kind];
  const target = join(staging, directoryName);
  try {
    await cp(join(themeDirectory, directoryName), target, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(target);
  }
  return target;
}

async function stageRestoredAssets(workspaceRoot: string, themeDirectory: string, staging: string, current: Draft, target: Draft) {
  for (const kind of Object.keys(assetDirectories) as AssetKind[]) {
    const stagedAssets = await copyAssetDirectory(themeDirectory, kind, staging);
    for (const asset of current.assets[kind]) {
      if (basename(asset.name) !== asset.name) throw new VaultError("INVALID_WORKSPACE", `Invalid Draft Asset name: ${asset.name}`);
      await rm(join(stagedAssets, asset.name), { recursive: true, force: true });
    }
    for (const asset of target.assets[kind]) {
      if (basename(asset.name) !== asset.name) throw new VaultError("INVALID_WORKSPACE", `Invalid stored Asset name: ${asset.name}`);
      const destination = join(stagedAssets, asset.name);
      await rm(destination, { recursive: true, force: true });
      await copyFile(await findBlob(workspaceRoot, asset.sha256), destination);
    }
  }
}

function detectImage(content: Uint8Array) {
  const header = Buffer.from(content.subarray(0, 16));
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "jpeg";
  if (header.subarray(0, 6).toString() === "GIF87a" || header.subarray(0, 6).toString() === "GIF89a") return "gif";
  if (header.subarray(0, 4).toString() === "RIFF" && header.subarray(8, 12).toString() === "WEBP") return "webp";
  if (header.length >= 12 && new Set(["ftypavif", "ftypavis"]).has(header.subarray(4, 12).toString())) return "avif";
  return null;
}

function safeAssetName(name: string) {
  const original = basename(name || "image");
  const extension = extname(original).toLowerCase();
  if (!imageExtensions.has(extension)) throw new VaultError("INVALID_WORKSPACE", `unsupported image type: ${original}`);
  const stem = basename(original, extension).replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^[.-]+|[.-]+$/g, "") || "image";
  return { original, extension, stem };
}

async function rawThemeMeta(themeDirectory: string) {
  return themeMetaSchema.parse(await readJson(join(themeDirectory, "theme.json"), themeMetaSchema)) as Record<string, unknown>;
}

async function rawRefs(themeDirectory: string) {
  return refsSchema.parse(await readOptionalJson(join(themeDirectory, "refs.json"), refsSchema) ?? {}) as z.infer<typeof refsSchema>;
}

async function findBlob(workspaceRoot: string, sha256: string) {
  const directory = join(workspaceRoot, ".assets", sha256.slice(0, 2));
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new VaultError("INVALID_WORKSPACE", `stored Asset is missing: ${sha256}`);
    throw error;
  }
  const name = names.find((candidate) => candidate.startsWith(`${sha256}.`));
  if (!name) throw new VaultError("INVALID_WORKSPACE", `stored Asset is missing: ${sha256}`);
  const path = join(directory, name);
  const content = await readFile(path);
  if (createHash("sha256").update(content).digest("hex") !== sha256) throw new VaultError("INVALID_WORKSPACE", `stored Asset failed integrity verification: ${sha256}`);
  return path;
}

async function storeDraftBlobs(workspaceRoot: string, themeDirectory: string, draft: Draft) {
  const created: string[] = [];
  try {
    for (const kind of Object.keys(assetDirectories) as AssetKind[]) {
      for (const asset of draft.assets[kind]) {
        const content = await readFile(join(themeDirectory, assetDirectories[kind], asset.name));
        const digest = createHash("sha256").update(content).digest("hex");
        if (digest !== asset.sha256) throw new VaultError("INVALID_WORKSPACE", `Draft Asset changed while saving: ${asset.name}`);
        try {
          await findBlob(workspaceRoot, asset.sha256);
          continue;
        } catch (error) {
          if (!(error instanceof VaultError) || !error.message.startsWith("stored Asset is missing:")) throw error;
        }
        const directory = join(workspaceRoot, ".assets", asset.sha256.slice(0, 2));
        await mkdir(directory, { recursive: true });
        const destination = join(directory, `${asset.sha256}${extname(asset.name).toLowerCase()}`);
        const temporary = join(directory, `.${asset.sha256}.${randomBytes(8).toString("hex")}.tmp`);
        const handle = await open(temporary, "wx", 0o600);
        try {
          try {
            await handle.writeFile(content);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, destination);
          created.push(destination);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
      }
    }
  } catch (error) {
    for (const path of created) await unlink(path).catch(() => undefined);
    throw error;
  }
  return created;
}

async function readVerifiedAsset(path: string, asset: { name: string; sha256: string; mime: string }): Promise<AssetContent> {
  const content = await readFile(path);
  if (createHash("sha256").update(content).digest("hex") !== asset.sha256) {
    throw new VaultError("INVALID_WORKSPACE", `Asset failed integrity verification: ${asset.name}`);
  }
  return { name: asset.name, mime: asset.mime || mimeFor(asset.name), content };
}

function toSummary(theme: Theme): ThemeSummary {
  const { referenceUrls: _referenceUrls, workingTitle: _workingTitle, draft: _draft, revisions: _revisions, ...summary } = theme;
  return summary;
}

export function createPromptVault({ workspace }: { workspace: string }): PromptVault {
  const workspaceRoot = resolve(workspace);

  async function withThemeLock<T>(slug: string, operation: () => Promise<T>) {
    if (!safeSlug.test(slug) || basename(slug) !== slug) throw new VaultError("NOT_FOUND", `Theme not found: ${slug}`);
    return withWorkspaceLock(workspaceRoot, slug, async () => {
      await recoverThemeTransaction(join(workspaceRoot, slug));
      return operation();
    });
  }

  async function readTheme(slug: string): Promise<Theme> {
    if (!safeSlug.test(slug) || basename(slug) !== slug) throw new VaultError("NOT_FOUND", `Theme not found: ${slug}`);
    const themeDirectory = join(workspaceRoot, slug);
    try {
      const info = await lstat(themeDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new VaultError("NOT_FOUND", `Theme not found: ${slug}`);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new VaultError("NOT_FOUND", `Theme not found: ${slug}`);
      throw error;
    }

    try {
      const meta = themeMetaSchema.parse(await readJson(join(themeDirectory, "theme.json"), themeMetaSchema));
      const refs = refsSchema.parse(await readOptionalJson(join(themeDirectory, "refs.json"), refsSchema) ?? {});
      const revisionRecords = await readAllRevisions(themeDirectory);
      const texts = await readTexts(themeDirectory);
      const draft: Draft = {
        ...texts,
        model: stringValue(meta.model),
        params: stringValue(meta.params),
        assets: await readAssets(themeDirectory, meta.asset_order),
      };
      let baseRevision: number | null;
      if (Object.hasOwn(refs, "working_base")) {
        baseRevision = refs.working_base ?? null;
      } else if (refs.branches) {
        baseRevision = refs.branches[refs.current_branch || "main"] ?? null;
      } else {
        const branchHeads = new Map<string, number>();
        for (const revision of revisionRecords) branchHeads.set(revision.manifest.branch || "main", revision.summary.id);
        const matchingHead = [...revisionRecords].reverse().find((revision) =>
          branchHeads.get(revision.manifest.branch || "main") === revision.summary.id
          && creativeState(revision.draft) === creativeState(draft),
        );
        const currentBranch = revisionRecords.at(-1)?.manifest.branch || "main";
        baseRevision = matchingHead?.summary.id ?? branchHeads.get(currentBranch) ?? null;
      }
      const baseDraft = revisionRecords.find((revision) => revision.summary.id === baseRevision)?.draft;
      if (baseRevision !== null && !baseDraft) {
        throw new VaultError("INVALID_WORKSPACE", `Base Revision ${baseRevision} does not exist for Theme ${slug}`);
      }
      const featured = new Set(refs.featured_commits ?? []);
      const favorite = new Set(refs.favorite_commits ?? []);
      const hidden = new Set(refs.hidden_commits ?? []);
      const revisions: RevisionSummary[] = revisionRecords.map(({ summary, draft: revisionDraft }) => ({
        ...summary,
        note: stringValue(refs.revision_titles?.[summary.id], summary.note),
        featured: featured.has(summary.id),
        favorite: favorite.has(summary.id),
        hidden: hidden.has(summary.id),
        previewAssets: revisionDraft.assets.result.map((asset) => ({ kind: "result" as const, name: asset.name, sha256: asset.sha256 })),
        previewAsset: revisionDraft.assets.result[0]
          ? { kind: "result" as const, name: revisionDraft.assets.result[0].name, sha256: revisionDraft.assets.result[0].sha256 }
          : revisionDraft.assets.reference[0]
            ? { kind: "reference" as const, name: revisionDraft.assets.reference[0].name, sha256: revisionDraft.assets.reference[0].sha256 }
            : undefined,
      })).reverse();

      return {
        slug,
        title: stringValue(meta.title).trim() || slug,
        description: stringValue(meta.description),
        category: stringValue(meta.category).trim() || "未分类",
        tags: stringArray(meta.tags),
        starred: Boolean(meta.starred),
        archived: Boolean(meta.archived),
        updatedAt: stringValue(meta.updated_at),
        referenceUrls: referenceUrlArray(meta.reference_urls),
        workingTitle: stringValue(refs.working_title),
        baseRevision,
        hasUnsavedChanges: baseDraft ? creativeState(draft) !== creativeState(baseDraft) : creativeState(draft) !== creativeState({ prompt: "", negative: "", notes: "", model: "", params: "", assets: { reference: [], result: [] } }),
        revisionCount: revisions.length,
        draft,
        revisions,
      };
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("INVALID_WORKSPACE", `Invalid Theme ${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function getTheme(slug: string): Promise<Theme> {
    return withThemeLock(slug, () => readTheme(slug));
  }

  async function revisionRecord(themeDirectory: string, revisionId: number) {
    if (!Number.isInteger(revisionId) || revisionId < 1) throw new VaultError("NOT_FOUND", `Revision not found: ${revisionId}`);
    const record = (await readAllRevisions(themeDirectory)).find((revision) => revision.summary.id === revisionId);
    if (!record) throw new VaultError("NOT_FOUND", `Revision not found: ${revisionId}`);
    return record;
  }

  async function readRevisionDetail(slug: string, revisionId: number): Promise<Revision> {
    const theme = await readTheme(slug);
    const summary = theme.revisions.find((revision) => revision.id === revisionId);
    if (!summary) throw new VaultError("NOT_FOUND", `Revision not found: ${revisionId}`);
    const record = await revisionRecord(join(workspaceRoot, slug), revisionId);
    return { ...summary, draft: record.draft };
  }

  async function getRevision(slug: string, revisionId: number): Promise<Revision> {
    return withThemeLock(slug, () => readRevisionDetail(slug, revisionId));
  }

  async function replaceDraftFromRevision(slug: string, revisionId: number, setBase: boolean, options: ReplaceDraftOptions = {}) {
    const themeDirectory = join(workspaceRoot, slug);
    return withThemeLock(slug, async () => {
      const theme = await readTheme(slug);
      if (theme.hasUnsavedChanges && !options.force) throw new VaultError("INVALID_WORKSPACE", "Theme has unsaved Draft changes; pass force to replace them");
      if (setBase && theme.baseRevision === revisionId && !theme.hasUnsavedChanges) return theme;
      const revision = await revisionRecord(themeDirectory, revisionId);
      const meta = await rawThemeMeta(themeDirectory);
      meta.model = revision.draft.model;
      meta.params = revision.draft.params;
      meta.asset_order = {
        reference: revision.draft.assets.reference.map((asset) => asset.name),
        result: revision.draft.assets.result.map((asset) => asset.name),
      };
      meta.updated_at = timestamp();
      meta.last_actor = "typescript";
      const staging = join(themeDirectory, `.revision-restore-${randomBytes(8).toString("hex")}`);
      await mkdir(staging);
      const names = ["theme.json", "prompt.md", "negative.md", "notes.md", "references", "outputs"];
      try {
        await Promise.all([
          writeFile(join(staging, "theme.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8"),
          writeFile(join(staging, "prompt.md"), revision.draft.prompt, "utf8"),
          writeFile(join(staging, "negative.md"), revision.draft.negative, "utf8"),
          writeFile(join(staging, "notes.md"), revision.draft.notes, "utf8"),
        ]);
        await stageRestoredAssets(workspaceRoot, themeDirectory, staging, theme.draft, revision.draft);
        if (setBase) {
          const refs = await rawRefs(themeDirectory);
          refs.working_base = revisionId;
          await writeFile(join(staging, "refs.json"), `${JSON.stringify(refs, null, 2)}\n`, "utf8");
          names.push("refs.json");
        }
        await installStagedEntries(themeDirectory, staging, names);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      return readTheme(slug);
    });
  }

  return {
    async listThemes(query = "") {
      let names: string[];
      try {
        const entries = await readdir(workspaceRoot, { withFileTypes: true });
        names = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const normalizedQuery = query.trim().toLocaleLowerCase();
      const themes: ThemeSummary[] = [];
      for (const slug of names) {
        if (!safeSlug.test(slug)) continue;
        try {
          const theme = await getTheme(slug);
          const searchable = [theme.title, theme.description, theme.category, theme.tags.join(" "), theme.draft.prompt, theme.draft.model].join(" ").toLocaleLowerCase();
          if (!normalizedQuery || searchable.includes(normalizedQuery)) themes.push(toSummary(theme));
        } catch (error) {
          if (!(error instanceof VaultError && (error.code === "INVALID_WORKSPACE" || error.code === "NOT_FOUND"))) throw error;
        }
      }
      return themes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.slug.localeCompare(right.slug));
    },
    getTheme,
    async createTheme(input: ThemeInput) {
      await mkdir(workspaceRoot, { recursive: true });
      return withWorkspaceLock(workspaceRoot, "workspace", async () => {
        const title = stringValue(input.title).trim() || "未命名主题";
        const base = slugify(title);
        let slug = base;
        for (let suffix = 2; ; suffix += 1) {
          try {
            await lstat(join(workspaceRoot, slug));
            slug = `${base.slice(0, 60)}-${suffix}`;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
            throw error;
          }
        }
        const now = timestamp();
        const staging = join(workspaceRoot, `.create-${randomBytes(8).toString("hex")}`);
        await mkdir(staging);
        try {
          for (const directory of ["references", "outputs", "history"]) await mkdir(join(staging, directory));
          const meta = {
            slug,
            title,
            description: stringValue(input.description).trim(),
            category: stringValue(input.category).trim() || "未分类",
            tags: stringArray(input.tags),
            starred: Boolean(input.starred),
            status: "active",
            archived: Boolean(input.archived),
            model: stringValue(input.model).trim(),
            params: stringValue(input.params).trim(),
            reference_urls: referenceUrlArray(input.referenceUrls),
            asset_order: { reference: [], result: [] },
            legacy: {},
            created_at: now,
            updated_at: now,
            last_actor: "typescript",
          };
          const refs = {
            current_branch: "main",
            branches: { main: null },
            working_base: null,
            tags: {},
            featured_commits: [],
            favorite_commits: [],
            hidden_commits: [],
            next_version: 1,
          };
          await Promise.all([
            writeFile(join(staging, "theme.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8"),
            writeFile(join(staging, "refs.json"), `${JSON.stringify(refs, null, 2)}\n`, "utf8"),
            writeFile(join(staging, "prompt.md"), stringValue(input.prompt), "utf8"),
            writeFile(join(staging, "negative.md"), stringValue(input.negative), "utf8"),
            writeFile(join(staging, "notes.md"), stringValue(input.notes), "utf8"),
          ]);
          await rename(staging, join(workspaceRoot, slug));
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        return readTheme(slug);
      });
    },
    async updateDraft(slug: string, input: DraftUpdate) {
      const themeDirectory = join(workspaceRoot, slug);
      return withThemeLock(slug, async () => {
        const theme = await readTheme(slug);
        const meta = await rawThemeMeta(themeDirectory);
        const fieldMap: Array<[keyof DraftUpdate, string]> = [
          ["title", "title"], ["description", "description"], ["category", "category"], ["model", "model"], ["params", "params"],
        ];
        for (const [inputName, metaName] of fieldMap) {
          if (inputName in input) meta[metaName] = stringValue(input[inputName]).trim();
        }
        if ("tags" in input) meta.tags = stringArray(input.tags);
        if ("starred" in input) meta.starred = Boolean(input.starred);
        if ("archived" in input) meta.archived = Boolean(input.archived);
        if ("referenceUrls" in input) meta.reference_urls = referenceUrlArray(input.referenceUrls);
        meta.updated_at = timestamp();
        meta.last_actor = "typescript";
        const files: Record<string, string> = {
          "theme.json": `${JSON.stringify(meta, null, 2)}\n`,
        };
        if ("prompt" in input) files["prompt.md"] = stringValue(input.prompt);
        if ("negative" in input) files["negative.md"] = stringValue(input.negative);
        if ("notes" in input) files["notes.md"] = stringValue(input.notes);
        await replaceThemeFiles(themeDirectory, files);
        return readTheme(slug);
      });
    },
    async applyDraftEdit(slug: string, input: ApplyDraftEditInput) {
      const themeDirectory = join(workspaceRoot, slug);
      return withThemeLock(slug, async () => {
        const theme = await readTheme(slug);
        if (input.saveRevision && input.overwriteRevision) {
          throw new VaultError("INVALID_WORKSPACE", "An editor transaction cannot save a child and overwrite a node at the same time");
        }
        if (input.overwriteRevision && input.sourceRevisionId !== input.overwriteRevision.revisionId) {
          throw new VaultError("INVALID_WORKSPACE", "The overwritten node must match the editor source node");
        }
        const records = await readAllRevisions(themeDirectory);
        const temporaryWorkspace = await mkdtemp(join(tmpdir(), "prompt-vault-edit-"));
        const temporaryTheme = join(temporaryWorkspace, slug);
        const createdLiveBlobs: string[] = [];
        try {
          await cp(themeDirectory, temporaryTheme, { recursive: true });
          for (const record of records) {
            for (const kind of Object.keys(assetDirectories) as AssetKind[]) {
              for (const asset of record.draft.assets[kind]) {
                const source = await findBlob(workspaceRoot, asset.sha256);
                const directory = join(temporaryWorkspace, ".assets", asset.sha256.slice(0, 2));
                await mkdir(directory, { recursive: true });
                const destination = join(directory, basename(source));
                if (!(await pathExists(destination))) await copyFile(source, destination);
              }
            }
          }

          const stagedVault = createPromptVault({ workspace: temporaryWorkspace });
          let stagedTheme = input.sourceRevisionId === undefined
            ? await stagedVault.getTheme(slug)
            : await stagedVault.continueFromRevision(slug, input.sourceRevisionId, { force: input.force });
          if (input.update && Object.keys(input.update).length) stagedTheme = await stagedVault.updateDraft(slug, input.update);
          for (const kind of Object.keys(input.assets ?? {}) as AssetKind[]) {
            const edit = input.assets?.[kind];
            if (!edit) continue;
            const original = stagedTheme.draft.assets[kind];
            const removed = new Set(edit.remove ?? []);
            for (const name of removed) stagedTheme = await stagedVault.removeAsset(slug, kind, name);
            const remainingNames = original.map((asset) => asset.name).filter((name) => !removed.has(name));
            if (edit.uploads?.length) stagedTheme = await stagedVault.addAssets(slug, kind, edit.uploads);
            if (edit.order) {
              const uploadedNames = stagedTheme.draft.assets[kind]
                .map((asset) => asset.name)
                .filter((name) => !remainingNames.includes(name))
                .slice(-(edit.uploads?.length ?? 0));
              const names = edit.order.flatMap((entry) => {
                const name = entry.source === "existing" ? original[entry.index]?.name : uploadedNames[entry.index];
                return name && !removed.has(name) ? [name] : [];
              });
              stagedTheme = await stagedVault.reorderAssets(slug, kind, names);
            }
          }
          if (input.nodeTitle !== undefined) {
            const refs = await rawRefs(temporaryTheme);
            refs.working_title = input.nodeTitle.trim();
            await writeFile(join(temporaryTheme, "refs.json"), `${JSON.stringify(refs, null, 2)}\n`, "utf8");
            stagedTheme = await stagedVault.getTheme(slug);
          }
          if (input.overwriteRevision) {
            const target = records.find((record) => record.summary.id === input.overwriteRevision!.revisionId);
            if (!target) throw new VaultError("NOT_FOUND", `Revision not found: ${input.overwriteRevision.revisionId}`);
            await storeDraftBlobs(temporaryWorkspace, temporaryTheme, stagedTheme.draft);
            const texts = {
              prompt: stagedTheme.draft.prompt,
              negative: stagedTheme.draft.negative,
              notes: stagedTheme.draft.notes,
            };
            const meta = { model: stagedTheme.draft.model, params: stagedTheme.draft.params };
            const assets: AssetGroups = {
              reference: stagedTheme.draft.assets.reference.map((asset) => ({ ...asset })),
              result: stagedTheme.draft.assets.result.map((asset) => ({ ...asset })),
            };
            const note = stringValue(input.overwriteRevision.note).trim()
              || theme.revisions.find((revision) => revision.id === target.summary.id)?.note
              || target.summary.note;
            const manifest = {
              ...target.manifest,
              change_note: note,
              actor: stringValue(input.overwriteRevision.actor).trim() || target.manifest.actor,
              meta,
              assets,
              digest: canonicalDigest({ meta, texts, assets }),
            } as Record<string, unknown>;
            delete manifest.integrity;
            manifest.integrity = canonicalDigest({ manifest, texts });
            const snapshot = join(temporaryTheme, "history", String(target.summary.id).padStart(4, "0"));
            await Promise.all([
              writeFile(join(snapshot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
              writeFile(join(snapshot, "prompt.md"), texts.prompt, "utf8"),
              writeFile(join(snapshot, "negative.md"), texts.negative, "utf8"),
              writeFile(join(snapshot, "notes.md"), texts.notes, "utf8"),
            ]);

            const synchronizeDraft = theme.baseRevision === target.summary.id && !theme.hasUnsavedChanges;
            if (!synchronizeDraft) {
              for (const name of ["theme.json", "refs.json", "prompt.md", "negative.md", "notes.md", "references", "outputs"]) {
                const destination = join(temporaryTheme, name);
                await rm(destination, { recursive: true, force: true });
                const source = join(themeDirectory, name);
                if (await pathExists(source)) await cp(source, destination, { recursive: true });
              }
            }
            const refs = await rawRefs(temporaryTheme);
            refs.revision_titles ??= {};
            refs.revision_titles[String(target.summary.id)] = note;
            await writeFile(join(temporaryTheme, "refs.json"), `${JSON.stringify(refs, null, 2)}\n`, "utf8");
            stagedTheme = await stagedVault.getTheme(slug);
          } else if (input.saveRevision) {
            stagedTheme = await stagedVault.saveRevision(slug, input.saveRevision);
          }

          try {
            await withWorkspaceLock(workspaceRoot, ".assets", async () => {
            const temporaryAssets = join(temporaryWorkspace, ".assets");
            if (await pathExists(temporaryAssets)) {
              for (const prefix of await readdir(temporaryAssets, { withFileTypes: true })) {
                if (!prefix.isDirectory() || prefix.isSymbolicLink()) continue;
                for (const asset of await readdir(join(temporaryAssets, prefix.name), { withFileTypes: true })) {
                  if (!asset.isFile() || asset.isSymbolicLink()) continue;
                  const destinationDirectory = join(workspaceRoot, ".assets", prefix.name);
                  const destination = join(destinationDirectory, asset.name);
                  if (await pathExists(destination)) {
                    const expectedDigest = asset.name.split(".")[0];
                    const actualDigest = createHash("sha256").update(await readFile(destination)).digest("hex");
                    if (actualDigest !== expectedDigest) throw new VaultError("INVALID_WORKSPACE", `stored Asset failed integrity verification: ${expectedDigest}`);
                    continue;
                  }
                  await mkdir(destinationDirectory, { recursive: true });
                  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
                  await copyFile(join(temporaryAssets, prefix.name, asset.name), temporary);
                  await rename(temporary, destination);
                  createdLiveBlobs.push(destination);
                }
              }
            }

            const staging = join(themeDirectory, `.draft-edit-${randomBytes(8).toString("hex")}`);
            await mkdir(staging);
            const candidates = ["theme.json", "refs.json", "prompt.md", "negative.md", "notes.md", "references", "outputs", "history"];
            const names = [];
            for (const name of candidates) if (await pathExists(join(temporaryTheme, name))) names.push(name);
            try {
              for (const name of names) await cp(join(temporaryTheme, name), join(staging, name), { recursive: true });
              await installStagedEntries(themeDirectory, staging, names);
            } catch (error) {
              if (!(error instanceof AggregateError)) {
                await rm(staging, { recursive: true, force: true });
                for (const path of createdLiveBlobs) await unlink(path).catch(() => undefined);
              }
              throw error;
            }
            });
          } catch (error) {
            if (!(error instanceof AggregateError)) {
              for (const path of createdLiveBlobs) await unlink(path).catch(() => undefined);
            }
            throw error;
          }
          return readTheme(slug);
        } finally {
          await rm(temporaryWorkspace, { recursive: true, force: true });
        }
      });
    },
    async overwriteRevision(slug: string, revisionId: number, input: OverwriteRevisionInput) {
      return this.applyDraftEdit(slug, {
        sourceRevisionId: revisionId,
        force: true,
        update: input.update,
        assets: input.assets,
        overwriteRevision: { revisionId, note: input.note, actor: input.actor },
      });
    },
    async addAssets(slug: string, kind: AssetKind, files: AssetUpload[]) {
      if (!(kind in assetDirectories)) throw new VaultError("INVALID_WORKSPACE", "Asset kind must be reference or result");
      if (!files.length) throw new VaultError("INVALID_WORKSPACE", "At least one image is required");
      const themeDirectory = join(workspaceRoot, slug);
      return withThemeLock(slug, async () => {
        const theme = await readTheme(slug);
        const targetDirectory = join(themeDirectory, assetDirectories[kind]);
        let existingNames: string[] = [];
        try {
          existingNames = await readdir(targetDirectory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const existing = new Set(existingNames.map((name) => name.toLocaleLowerCase()));
        const stagedNames = new Set<string>();
        const validated = files.map((file) => {
          if (file.content.byteLength > 64 * 1024 * 1024) throw new VaultError("INVALID_WORKSPACE", `image is too large: ${file.name}`);
          const { original, extension, stem } = safeAssetName(file.name);
          const detected = detectImage(file.content);
          const expected = new Set([".jpg", ".jpeg"]).has(extension) ? "jpeg" : extension.slice(1);
          if (detected !== expected) throw new VaultError("INVALID_WORKSPACE", `file content is not a valid ${expected} image: ${original}`);
          let name = `${stem.slice(0, 80)}${extension}`;
          while (existing.has(name.toLocaleLowerCase()) || stagedNames.has(name.toLocaleLowerCase())) {
            name = `${stem.slice(0, 70)}-${randomBytes(4).toString("hex")}${extension}`;
          }
          stagedNames.add(name.toLocaleLowerCase());
          return { name, content: file.content };
        });
        const meta = await rawThemeMeta(themeDirectory);
        const order = assetOrderSchema.parse(meta.asset_order) ?? {};
        meta.asset_order = {
          reference: order.reference ?? theme.draft.assets.reference.map((asset) => asset.name),
          result: order.result ?? theme.draft.assets.result.map((asset) => asset.name),
          [kind]: [...theme.draft.assets[kind].map((asset) => asset.name), ...validated.map((file) => file.name)],
        };
        meta.updated_at = timestamp();
        meta.last_actor = "typescript";
        const staging = join(themeDirectory, `.asset-add-${randomBytes(8).toString("hex")}`);
        await mkdir(staging);
        try {
          const stagedAssets = await copyAssetDirectory(themeDirectory, kind, staging);
          for (const file of validated) await writeFile(join(stagedAssets, file.name), file.content);
          await writeFile(join(staging, "theme.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
          await installStagedEntries(themeDirectory, staging, ["theme.json", assetDirectories[kind]]);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        return readTheme(slug);
      });
    },
    async reorderAssets(slug: string, kind: AssetKind, names: string[]) {
      if (!(kind in assetDirectories)) throw new VaultError("INVALID_WORKSPACE", "Asset kind must be reference or result");
      const themeDirectory = join(workspaceRoot, slug);
      return withThemeLock(slug, async () => {
        const theme = await readTheme(slug);
        const current = theme.draft.assets[kind].map((asset) => asset.name);
        if (names.length !== current.length || new Set(names).size !== names.length || names.some((name) => !current.includes(name))) {
          throw new VaultError("INVALID_WORKSPACE", "Asset order must contain every current Asset exactly once");
        }
        const meta = await rawThemeMeta(themeDirectory);
        const order = assetOrderSchema.parse(meta.asset_order) ?? {};
        meta.asset_order = {
          reference: order.reference ?? theme.draft.assets.reference.map((asset) => asset.name),
          result: order.result ?? theme.draft.assets.result.map((asset) => asset.name),
          [kind]: names,
        };
        meta.updated_at = timestamp();
        meta.last_actor = "typescript";
        await replaceThemeFiles(themeDirectory, { "theme.json": `${JSON.stringify(meta, null, 2)}\n` });
        return readTheme(slug);
      });
    },
    async removeAsset(slug: string, kind: AssetKind, name: string) {
      if (!(kind in assetDirectories) || basename(name) !== name) throw new VaultError("INVALID_WORKSPACE", "Invalid Asset");
      const themeDirectory = join(workspaceRoot, slug);
      return withThemeLock(slug, async () => {
        const theme = await readTheme(slug);
        if (!theme.draft.assets[kind].some((asset) => asset.name === name)) throw new VaultError("NOT_FOUND", `Asset not found: ${name}`);
        const meta = await rawThemeMeta(themeDirectory);
        const order = assetOrderSchema.parse(meta.asset_order) ?? {};
        meta.asset_order = {
          reference: order.reference ?? theme.draft.assets.reference.map((asset) => asset.name),
          result: order.result ?? theme.draft.assets.result.map((asset) => asset.name),
          [kind]: theme.draft.assets[kind].map((asset) => asset.name).filter((assetName) => assetName !== name),
        };
        meta.updated_at = timestamp();
        meta.last_actor = "typescript";
        const staging = join(themeDirectory, `.asset-remove-${randomBytes(8).toString("hex")}`);
        await mkdir(staging);
        try {
          const stagedAssets = await copyAssetDirectory(themeDirectory, kind, staging);
          await unlink(join(stagedAssets, name));
          await writeFile(join(staging, "theme.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
          await installStagedEntries(themeDirectory, staging, ["theme.json", assetDirectories[kind]]);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        return readTheme(slug);
      });
    },
    async discardDraft(slug: string) {
      const themeDirectory = join(workspaceRoot, slug);
      return withThemeLock(slug, async () => {
        const theme = await readTheme(slug);
        if (!theme.hasUnsavedChanges) return theme;
        const meta = await rawThemeMeta(themeDirectory);
        let target: Draft = { prompt: "", negative: "", notes: "", model: "", params: "", assets: { reference: [], result: [] } };
        if (theme.baseRevision !== null) {
          const revision = (await readAllRevisions(themeDirectory)).find((record) => record.summary.id === theme.baseRevision);
          if (!revision) throw new VaultError("INVALID_WORKSPACE", `Base Revision ${theme.baseRevision} does not exist for Theme ${slug}`);
          target = revision.draft;
        }
        meta.model = target.model;
        meta.params = target.params;
        meta.asset_order = {
          reference: target.assets.reference.map((asset) => asset.name),
          result: target.assets.result.map((asset) => asset.name),
        };
        meta.updated_at = timestamp();
        meta.last_actor = "typescript";
        const staging = join(themeDirectory, `.discard-${randomBytes(8).toString("hex")}`);
        await mkdir(staging);
        try {
          await Promise.all([
            writeFile(join(staging, "theme.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8"),
            writeFile(join(staging, "prompt.md"), target.prompt, "utf8"),
            writeFile(join(staging, "negative.md"), target.negative, "utf8"),
            writeFile(join(staging, "notes.md"), target.notes, "utf8"),
          ]);
          await stageRestoredAssets(workspaceRoot, themeDirectory, staging, theme.draft, target);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        await installStagedEntries(themeDirectory, staging, ["theme.json", "prompt.md", "negative.md", "notes.md", "references", "outputs"]);
        return readTheme(slug);
      });
    },
    async saveRevision(slug: string, input: SaveRevisionInput = {}) {
      const themeDirectory = join(workspaceRoot, slug);
      return withThemeLock(slug, async () => {
        const theme = await readTheme(slug);
        const records = await readAllRevisions(themeDirectory);
        const parentIds = [...new Set(input.parentIds ?? (theme.baseRevision === null ? [] : [theme.baseRevision]))];
        if (parentIds.some((id) => !Number.isInteger(id) || id < 1)) throw new VaultError("INVALID_WORKSPACE", "Revision parents must be positive integers");
        for (const parentId of parentIds) {
          if (!records.some((record) => record.summary.id === parentId)) throw new VaultError("NOT_FOUND", `Revision not found: ${parentId}`);
        }
        if (!theme.hasUnsavedChanges && parentIds.length < 2) throw new VaultError("INVALID_WORKSPACE", "Draft has no unsaved changes to save");

        const refs = await rawRefs(themeDirectory);
        const nextAvailable = Math.max(1, ...records.map((record) => record.summary.id + 1));
        const revisionId = Math.max(refs.next_version ?? nextAvailable, nextAvailable);
        const revisionMeta = { model: theme.draft.model, params: theme.draft.params };
        const texts = { prompt: theme.draft.prompt, negative: theme.draft.negative, notes: theme.draft.notes };
        const assets: AssetGroups = {
          reference: theme.draft.assets.reference.map((asset) => ({ ...asset })),
          result: theme.draft.assets.result.map((asset) => ({ ...asset })),
        };
        const digest = canonicalDigest({ meta: revisionMeta, texts, assets });
        const createdAt = timestamp();
        const currentBranch = refs.current_branch || "main";
        const manifest: Record<string, unknown> = {
          version: revisionId,
          parent: parentIds[0] ?? null,
          parents: parentIds,
          branch: currentBranch,
          digest,
          created_at: createdAt,
          actor: stringValue(input.actor).trim() || "typescript",
          change_note: stringValue(input.note).trim() || digest.slice(0, 6),
          meta: revisionMeta,
          assets,
        };
        manifest.integrity = canonicalDigest({ manifest, texts });

        return withWorkspaceLock(workspaceRoot, ".assets", async () => {
          const createdBlobs = await storeDraftBlobs(workspaceRoot, themeDirectory, theme.draft);
          const staging = join(themeDirectory, `.revision-save-${randomBytes(8).toString("hex")}`);
          try {
            await mkdir(staging);
            const stagedHistory = join(staging, "history");
            try {
              await cp(join(themeDirectory, "history"), stagedHistory, { recursive: true });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              await mkdir(stagedHistory);
            }
            const snapshot = join(stagedHistory, String(revisionId).padStart(4, "0"));
            await mkdir(snapshot);
            await Promise.all([
              writeFile(join(snapshot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
              writeFile(join(snapshot, "prompt.md"), texts.prompt, "utf8"),
              writeFile(join(snapshot, "negative.md"), texts.negative, "utf8"),
              writeFile(join(snapshot, "notes.md"), texts.notes, "utf8"),
            ]);

            const branches = { ...(refs.branches ?? { [currentBranch]: theme.baseRevision }), [currentBranch]: revisionId };
            refs.current_branch = currentBranch;
            refs.branches = branches;
            refs.working_base = revisionId;
            refs.next_version = revisionId + 1;
            refs.featured_commits ??= [];
            refs.favorite_commits ??= [];
            refs.hidden_commits ??= [];
            refs.tags ??= {};
            const themeMeta = await rawThemeMeta(themeDirectory);
            themeMeta.updated_at = createdAt;
            themeMeta.last_actor = manifest.actor;
            await Promise.all([
              writeFile(join(staging, "theme.json"), `${JSON.stringify(themeMeta, null, 2)}\n`, "utf8"),
              writeFile(join(staging, "refs.json"), `${JSON.stringify(refs, null, 2)}\n`, "utf8"),
            ]);
            await installStagedEntries(themeDirectory, staging, ["theme.json", "refs.json", "history"]);
          } catch (error) {
            await rm(staging, { recursive: true, force: true });
            if (!(error instanceof AggregateError)) {
              for (const path of createdBlobs) await unlink(path).catch(() => undefined);
            }
            throw error;
          }
          return readTheme(slug);
        });
      });
    },
    getRevision,
    async getLineage(slug: string): Promise<Lineage> {
      const theme = await getTheme(slug);
      return {
        revisions: theme.revisions,
        edges: theme.revisions.flatMap((revision) => revision.parentIds.map((parentId) => ({ parentId, childId: revision.id }))),
      };
    },
    async continueFromRevision(slug: string, revisionId: number, options?: ReplaceDraftOptions) {
      return replaceDraftFromRevision(slug, revisionId, true, options);
    },
    async restoreRevision(slug: string, revisionId: number, options?: ReplaceDraftOptions) {
      return replaceDraftFromRevision(slug, revisionId, false, options);
    },
    async compareRevisions(slug: string, leftId: number, rightId: number): Promise<RevisionComparison> {
      const [left, right] = await Promise.all([getRevision(slug, leftId), getRevision(slug, rightId)]);
      const diffs = Object.fromEntries((["prompt", "negative", "notes"] as const).map((field) => [
        field,
        createTwoFilesPatch(`Revision ${leftId} ${field}`, `Revision ${rightId} ${field}`, left.draft[field], right.draft[field], "", "", { context: 3 }),
      ])) as RevisionComparison["diffs"];
      const metadataChanges: RevisionComparison["metadataChanges"] = [];
      for (const field of ["model", "params"] as const) {
        if (left.draft[field] !== right.draft[field]) metadataChanges.push({ field, left: left.draft[field], right: right.draft[field] });
      }
      const assetChanges = Object.fromEntries((Object.keys(assetDirectories) as AssetKind[]).map((kind) => {
        const leftAssets = new Map(left.draft.assets[kind].map((asset) => [`${asset.name}\0${asset.sha256}`, asset]));
        const rightAssets = new Map(right.draft.assets[kind].map((asset) => [`${asset.name}\0${asset.sha256}`, asset]));
        return [kind, {
          removed: [...leftAssets].filter(([key]) => !rightAssets.has(key)).map(([, asset]) => ({ name: asset.name, sha256: asset.sha256 })),
          added: [...rightAssets].filter(([key]) => !leftAssets.has(key)).map(([, asset]) => ({ name: asset.name, sha256: asset.sha256 })),
          orderChanged: left.draft.assets[kind].map((asset) => asset.name).join("\0") !== right.draft.assets[kind].map((asset) => asset.name).join("\0"),
          leftOrder: left.draft.assets[kind].map((asset) => asset.name),
          rightOrder: right.draft.assets[kind].map((asset) => asset.name),
        }];
      })) as RevisionComparison["assetChanges"];
      return { left, right, diffs, metadataChanges, assetChanges };
    },
    async duplicateTheme(slug: string) {
      return withThemeLock(slug, async () => {
        const source = await readTheme(slug);
        let duplicate: Theme | undefined;
        try {
          duplicate = await this.createTheme({
            title: `${source.title} 副本`,
            description: source.description,
            category: source.category,
            tags: source.tags,
            prompt: source.draft.prompt,
            negative: source.draft.negative,
            notes: source.draft.notes,
            model: source.draft.model,
            params: source.draft.params,
            referenceUrls: source.referenceUrls,
          });
          for (const kind of Object.keys(assetDirectories) as AssetKind[]) {
            const files = await Promise.all(source.draft.assets[kind].map(async (asset) => ({
              name: asset.name,
              content: new Uint8Array(await readFile(join(workspaceRoot, slug, assetDirectories[kind], asset.name))),
            })));
            if (files.length) duplicate = await this.addAssets(duplicate.slug, kind, files);
            const managed = new Set(source.draft.assets[kind].map((asset) => asset.name));
            const entries = await readdir(join(workspaceRoot, slug, assetDirectories[kind]), { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isFile() || entry.isSymbolicLink() || managed.has(entry.name)) continue;
              await copyFile(
                join(workspaceRoot, slug, assetDirectories[kind], entry.name),
                join(workspaceRoot, duplicate.slug, assetDirectories[kind], entry.name),
              );
            }
          }
          return duplicate;
        } catch (error) {
          if (duplicate) await rm(join(workspaceRoot, duplicate.slug), { recursive: true, force: true });
          throw error;
        }
      });
    },
    async deleteTheme(slug: string) {
      await withThemeLock(slug, async () => {
        await withWorkspaceLock(workspaceRoot, "workspace", async () => {
          const themeDirectory = join(workspaceRoot, slug);
          await readTheme(slug);
          const trash = join(workspaceRoot, ".trash");
          await mkdir(trash, { recursive: true });
          await rename(themeDirectory, join(trash, `${slug}-${Date.now()}-${randomBytes(4).toString("hex")}`));
        });
      });
    },
    async setNodeTitle(slug: string, revisionId: number | null, title: string) {
      const normalized = title.trim();
      if (!normalized) throw new VaultError("INVALID_WORKSPACE", "Node title cannot be empty");
      return withThemeLock(slug, async () => {
        const themeDirectory = join(workspaceRoot, slug);
        if (revisionId !== null) await revisionRecord(themeDirectory, revisionId);
        const refs = await rawRefs(themeDirectory);
        if (revisionId === null) refs.working_title = normalized;
        else {
          refs.revision_titles ??= {};
          refs.revision_titles[String(revisionId)] = normalized;
        }
        await replaceThemeFiles(themeDirectory, { "refs.json": `${JSON.stringify(refs, null, 2)}\n` });
        return readTheme(slug);
      });
    },
    async setRevisionMarks(slug: string, revisionId: number, marks: RevisionMarks) {
      const entries = Object.entries(marks).filter((entry): entry is [keyof RevisionMarks, boolean] => entry[1] !== undefined);
      if (!entries.length) throw new VaultError("INVALID_WORKSPACE", "Pass at least one Revision mark");
      if (entries.some(([, value]) => typeof value !== "boolean")) throw new VaultError("INVALID_WORKSPACE", "Revision marks must be boolean values");
      return withThemeLock(slug, async () => {
        const themeDirectory = join(workspaceRoot, slug);
        await revisionRecord(themeDirectory, revisionId);
        const refs = await rawRefs(themeDirectory);
        const fields: Record<keyof RevisionMarks, "featured_commits" | "favorite_commits" | "hidden_commits"> = {
          featured: "featured_commits",
          favorite: "favorite_commits",
          hidden: "hidden_commits",
        };
        for (const [mark, enabled] of entries) {
          const field = fields[mark];
          const values = new Set(refs[field] ?? []);
          if (enabled) values.add(revisionId);
          else values.delete(revisionId);
          refs[field] = [...values].sort((left, right) => left - right);
        }
        await replaceThemeFiles(themeDirectory, { "refs.json": `${JSON.stringify(refs, null, 2)}\n` });
        return readTheme(slug);
      });
    },
    async deleteRevision(slug: string, revisionId: number, options: DeleteRevisionOptions = {}) {
      return withThemeLock(slug, async () => {
        const themeDirectory = join(workspaceRoot, slug);
        const theme = await readTheme(slug);
        const records = await readAllRevisions(themeDirectory);
        const target = records.find((record) => record.summary.id === revisionId);
        if (!target) throw new VaultError("NOT_FOUND", `Revision not found: ${revisionId}`);
        if (records.some((record) => record.summary.parentIds.includes(revisionId))) {
          throw new VaultError("INVALID_WORKSPACE", "Cannot delete a Revision with descendants");
        }
        const affectsDraft = theme.baseRevision === revisionId;
        if (affectsDraft && theme.hasUnsavedChanges && !options.force) {
          throw new VaultError("INVALID_WORKSPACE", "Theme has unsaved Draft changes; pass force to delete its Base Revision");
        }
        const nextBase = target.summary.parentIds[0] ?? null;
        const nextDraft = nextBase === null
          ? { prompt: "", negative: "", notes: "", model: "", params: "", assets: { reference: [], result: [] } } satisfies Draft
          : records.find((record) => record.summary.id === nextBase)?.draft;
        if (affectsDraft && !nextDraft) throw new VaultError("INVALID_WORKSPACE", `Parent Revision ${nextBase} does not exist`);

        const refs = await rawRefs(themeDirectory);
        if (affectsDraft) refs.working_base = nextBase;
        if (refs.branches) {
          for (const [name, head] of Object.entries(refs.branches)) if (head === revisionId) refs.branches[name] = nextBase;
        }
        if (refs.tags) refs.tags = Object.fromEntries(Object.entries(refs.tags).filter(([, id]) => id !== revisionId));
        if (refs.revision_titles) delete refs.revision_titles[String(revisionId)];
        for (const field of ["featured_commits", "favorite_commits", "hidden_commits"] as const) {
          refs[field] = (refs[field] ?? []).filter((id) => id !== revisionId);
        }

        const staging = join(themeDirectory, `.revision-delete-${randomBytes(8).toString("hex")}`);
        await mkdir(staging);
        const names = ["refs.json", "history"];
        try {
          const stagedHistory = join(staging, "history");
          await cp(join(themeDirectory, "history"), stagedHistory, { recursive: true });
          await rm(join(stagedHistory, String(revisionId).padStart(4, "0")), { recursive: true });
          await writeFile(join(staging, "refs.json"), `${JSON.stringify(refs, null, 2)}\n`, "utf8");
          if (affectsDraft) {
            const draft = nextDraft!;
            const meta = await rawThemeMeta(themeDirectory);
            meta.model = draft.model;
            meta.params = draft.params;
            meta.asset_order = {
              reference: draft.assets.reference.map((asset) => asset.name),
              result: draft.assets.result.map((asset) => asset.name),
            };
            meta.updated_at = timestamp();
            meta.last_actor = "typescript";
            await Promise.all([
              writeFile(join(staging, "theme.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8"),
              writeFile(join(staging, "prompt.md"), draft.prompt, "utf8"),
              writeFile(join(staging, "negative.md"), draft.negative, "utf8"),
              writeFile(join(staging, "notes.md"), draft.notes, "utf8"),
            ]);
            await stageRestoredAssets(workspaceRoot, themeDirectory, staging, theme.draft, draft);
            names.push("theme.json", "prompt.md", "negative.md", "notes.md", "references", "outputs");
          }
          await installStagedEntries(themeDirectory, staging, names);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        return readTheme(slug);
      });
    },
    async getStatistics(): Promise<VaultStatistics> {
      const summaries = await this.listThemes();
      const themes = await Promise.all(summaries.map((summary) => this.getTheme(summary.slug)));
      return {
        themes: themes.length,
        active: themes.filter((theme) => !theme.archived).length,
        archived: themes.filter((theme) => theme.archived).length,
        starred: themes.filter((theme) => theme.starred || theme.revisions.some((revision) => revision.favorite)).length,
        revisions: themes.reduce((count, theme) => count + theme.revisionCount, 0),
        references: themes.reduce((count, theme) => count + theme.draft.assets.reference.length, 0),
        results: themes.reduce((count, theme) => count + theme.draft.assets.result.length, 0),
      };
    },
    async exportVault(): Promise<VaultExport> {
      const summaries = await this.listThemes();
      return { format: "prompt-vault/themes/v2", themes: await Promise.all(summaries.map((summary) => this.getTheme(summary.slug))) };
    },
    async synchronizeWorkspace(): Promise<WorkspaceSynchronization> {
      let entries: Dirent[];
      try {
        entries = await readdir(workspaceRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { unsavedThemes: [], count: 0, errors: {} };
        throw error;
      }
      const unsavedThemes: string[] = [];
      const errors: Record<string, string> = {};
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !safeSlug.test(entry.name)) continue;
        try {
          const theme = await this.getTheme(entry.name);
          if (theme.hasUnsavedChanges) unsavedThemes.push(entry.name);
        } catch (error) {
          if (error instanceof VaultError) errors[entry.name] = error.message;
          else throw error;
        }
      }
      unsavedThemes.sort();
      return { unsavedThemes, count: unsavedThemes.length, errors };
    },
    getCapabilities(): VaultCapabilities {
      return {
        format: "prompt-vault/capabilities/v1",
        concepts: ["Theme", "Draft", "Revision", "Lineage", "Asset", "Vault Host"],
        mutations: [
          { name: "createTheme", safety: "Creates one new Theme with an editable Draft and no Revision." },
          { name: "updateDraft", safety: "Changes only the editable Draft and shared Theme metadata." },
          { name: "applyDraftEdit", safety: "Applies text, Asset, continue, and optional Revision-save changes as one atomic transaction; replacing a dirty Draft requires force." },
          { name: "discardDraft", safety: "Permanently replaces unsaved Draft content with its Base Revision while preserving Revision history." },
          { name: "addAssets", safety: "Validates an image batch before changing the Draft." },
          { name: "reorderAssets", safety: "Requires every current Draft Asset exactly once." },
          { name: "removeAsset", safety: "Removes only the named Draft Asset." },
          { name: "saveRevision", safety: "Creates a new child Revision without changing its parent node." },
          { name: "overwriteRevision", safety: "Atomically replaces one existing node's content while preserving its identity and Lineage." },
          { name: "continueFromRevision", safety: "Replaces the Draft only after unsaved-change confirmation." },
          { name: "restoreRevision", safety: "Copies Revision content into the Draft without changing the Base Revision; replacing a dirty Draft requires force." },
          { name: "setNodeTitle", safety: "Changes a mutable display title in refs without rewriting immutable Revision content." },
          { name: "setRevisionMarks", safety: "Changes external featured, favorite, and hidden marks without rewriting a Revision." },
          { name: "deleteRevision", safety: "Permanently deletes only a leaf Revision and refuses unsaved Base Revision changes unless forced." },
          { name: "duplicateTheme", safety: "Copies the current Draft and Assets into a new Theme without Revision history." },
          { name: "deleteTheme", safety: "Moves the entire Theme to the workspace trash instead of erasing it immediately." },
        ],
      };
    },
    async readDraftAsset(slug: string, kind: AssetKind, name: string) {
      if (!(kind in assetDirectories) || basename(name) !== name) throw new VaultError("NOT_FOUND", `Asset not found: ${name}`);
      return withThemeLock(slug, async () => {
        const theme = await readTheme(slug);
        const asset = theme.draft.assets[kind].find((candidate) => candidate.name === name);
        if (!asset) throw new VaultError("NOT_FOUND", `Asset not found: ${name}`);
        return readVerifiedAsset(join(workspaceRoot, slug, assetDirectories[kind], name), asset);
      });
    },
    async readRevisionAsset(slug: string, revisionId: number, kind: AssetKind, name: string) {
      if (!(kind in assetDirectories) || basename(name) !== name) throw new VaultError("NOT_FOUND", `Asset not found: ${name}`);
      return withThemeLock(slug, async () => {
        const revision = await readRevisionDetail(slug, revisionId);
        const asset = revision.draft.assets[kind].find((candidate) => candidate.name === name);
        if (!asset) throw new VaultError("NOT_FOUND", `Asset not found: ${name}`);
        return readVerifiedAsset(await findBlob(workspaceRoot, asset.sha256), asset);
      });
    },
  };
}
