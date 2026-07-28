export type AssetKind = "reference" | "result";

export type AssetRecord = {
  name: string;
  sha256: string;
  size: number;
  mime: string;
};

export type AssetGroups = Record<AssetKind, AssetRecord[]>;

export type Draft = {
  prompt: string;
  negative: string;
  notes: string;
  model: string;
  params: string;
  assets: AssetGroups;
};

export type RevisionSummary = {
  id: number;
  parentIds: number[];
  note: string;
  actor: string;
  createdAt: string;
  digest: string;
  promptExcerpt: string;
  featured: boolean;
  favorite: boolean;
  hidden: boolean;
  previewAsset?: { kind: AssetKind; name: string; sha256: string };
  previewAssets?: Array<{ kind: AssetKind; name: string; sha256: string }>;
};

export type Revision = RevisionSummary & { draft: Draft };

export type Lineage = {
  revisions: RevisionSummary[];
  edges: Array<{ parentId: number; childId: number }>;
};

export type RevisionComparison = {
  left: Revision;
  right: Revision;
  diffs: Record<"prompt" | "negative" | "notes", string>;
  metadataChanges: Array<{ field: "model" | "params"; left: string; right: string }>;
  assetChanges: Record<AssetKind, {
    removed: Array<{ name: string; sha256: string }>;
    added: Array<{ name: string; sha256: string }>;
    orderChanged: boolean;
    leftOrder: string[];
    rightOrder: string[];
  }>;
};

export type SaveRevisionInput = {
  note?: string;
  actor?: string;
  parentIds?: number[];
};

export type ReplaceDraftOptions = { force?: boolean };

export type RevisionMarks = Partial<Pick<RevisionSummary, "featured" | "favorite" | "hidden">>;

export type DeleteRevisionOptions = { force?: boolean };

export type VaultStatistics = {
  themes: number;
  active: number;
  archived: number;
  starred: number;
  revisions: number;
  references: number;
  results: number;
};

export type WorkspaceSynchronization = {
  unsavedThemes: string[];
  count: number;
  errors: Record<string, string>;
};

export type VaultExport = {
  format: "prompt-vault/themes/v2";
  themes: Theme[];
};

export type VaultCapabilities = {
  format: "prompt-vault/capabilities/v1";
  concepts: ["Theme", "Draft", "Revision", "Lineage", "Asset", "Vault Host"];
  mutations: Array<{ name: string; safety: string }>;
};

export type ThemeSummary = {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  starred: boolean;
  archived: boolean;
  updatedAt: string;
  baseRevision: number | null;
  hasUnsavedChanges: boolean;
  revisionCount: number;
};

export type Theme = ThemeSummary & {
  referenceUrls: string[];
  workingTitle: string;
  draft: Draft;
  revisions: RevisionSummary[];
};

export type ThemeInput = {
  title: string;
  description?: string;
  category?: string;
  tags?: string[];
  starred?: boolean;
  archived?: boolean;
  prompt?: string;
  negative?: string;
  notes?: string;
  model?: string;
  params?: string;
  referenceUrls?: string[];
};

export type DraftUpdate = Partial<Omit<ThemeInput, "title">> & { title?: string };

export type AssetUpload = { name: string; content: Uint8Array };
export type AssetContent = { name: string; mime: string; content: Uint8Array };

export type AssetOrderEntry = { source: "existing" | "upload"; index: number };

export type DraftAssetEdit = {
  remove?: string[];
  uploads?: AssetUpload[];
  order?: AssetOrderEntry[];
};

export type ApplyDraftEditInput = {
  sourceRevisionId?: number;
  force?: boolean;
  nodeTitle?: string;
  update?: Pick<DraftUpdate, "prompt" | "negative" | "notes" | "model" | "params">;
  assets?: Partial<Record<AssetKind, DraftAssetEdit>>;
  saveRevision?: SaveRevisionInput;
  overwriteRevision?: { revisionId: number; note?: string; actor?: string };
};

export type OverwriteRevisionInput = Pick<ApplyDraftEditInput, "update" | "assets"> & {
  note?: string;
  actor?: string;
};

export interface PromptVault {
  listThemes(query?: string): Promise<ThemeSummary[]>;
  getTheme(slug: string): Promise<Theme>;
  createTheme(input: ThemeInput): Promise<Theme>;
  updateDraft(slug: string, input: DraftUpdate): Promise<Theme>;
  applyDraftEdit(slug: string, input: ApplyDraftEditInput): Promise<Theme>;
  addAssets(slug: string, kind: AssetKind, files: AssetUpload[]): Promise<Theme>;
  reorderAssets(slug: string, kind: AssetKind, names: string[]): Promise<Theme>;
  removeAsset(slug: string, kind: AssetKind, name: string): Promise<Theme>;
  discardDraft(slug: string): Promise<Theme>;
  saveRevision(slug: string, input?: SaveRevisionInput): Promise<Theme>;
  overwriteRevision(slug: string, revisionId: number, input: OverwriteRevisionInput): Promise<Theme>;
  getRevision(slug: string, revisionId: number): Promise<Revision>;
  getLineage(slug: string): Promise<Lineage>;
  continueFromRevision(slug: string, revisionId: number, options?: ReplaceDraftOptions): Promise<Theme>;
  restoreRevision(slug: string, revisionId: number, options?: ReplaceDraftOptions): Promise<Theme>;
  compareRevisions(slug: string, leftId: number, rightId: number): Promise<RevisionComparison>;
  duplicateTheme(slug: string): Promise<Theme>;
  deleteTheme(slug: string): Promise<void>;
  setNodeTitle(slug: string, revisionId: number | null, title: string): Promise<Theme>;
  setRevisionMarks(slug: string, revisionId: number, marks: RevisionMarks): Promise<Theme>;
  deleteRevision(slug: string, revisionId: number, options?: DeleteRevisionOptions): Promise<Theme>;
  getStatistics(): Promise<VaultStatistics>;
  exportVault(): Promise<VaultExport>;
  synchronizeWorkspace(): Promise<WorkspaceSynchronization>;
  getCapabilities(): VaultCapabilities;
  readDraftAsset(slug: string, kind: AssetKind, name: string): Promise<AssetContent>;
  readRevisionAsset(slug: string, revisionId: number, kind: AssetKind, name: string): Promise<AssetContent>;
}

export type VaultErrorCode = "NOT_FOUND" | "INVALID_WORKSPACE";

export class VaultError extends Error {
  constructor(
    public readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}
