export type Asset = {
  name: string;
  sha256: string;
  size: number;
  mime: string;
  url: string;
};

export type AssetGroups = {
  reference: Asset[];
  result: Asset[];
};

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
  previewAsset?: { kind: "reference" | "result"; name: string; sha256: string };
  previewAssets?: Array<{ kind: "reference" | "result"; name: string; sha256: string }>;
  previewUrl?: string | null;
  previewUrls: string[];
};

export type Revision = RevisionSummary & { draft: Draft };

export type Theme = {
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
  referenceUrls: string[];
  workingTitle: string;
  draft: Draft;
  revisions: RevisionSummary[];
  representativeRevisions: Array<{ id: number; note: string; previewUrl: string; sha256: string }>;
  hasFavoriteRevisions: boolean;
};

export type Comparison = {
  left: Revision;
  right: Revision;
  diffs: Record<"prompt" | "negative" | "notes", string>;
  metadataChanges: Array<{ field: string; left: string; right: string }>;
  assetChanges: Record<"reference" | "result", {
    removed: Array<{ name: string; sha256: string }>;
    added: Array<{ name: string; sha256: string }>;
    orderChanged: boolean;
    leftOrder: string[];
    rightOrder: string[];
  }>;
};

export type ThemeFilter = "active" | "archived" | "favorite" | "all";
export type CanvasMode = "pan" | "select";
export type EditorIntent = "updateDraft" | "saveRevision";

export type EditorDraft = {
  note: string;
  prompt: string;
  negative: string;
  notes: string;
  model: string;
  params: string;
  parentIds: number[];
};
