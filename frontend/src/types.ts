export type Asset = {
  name: string;
  sha256: string;
  url: string;
};

export type AssetGroups = {
  reference: Asset[];
  result: Asset[];
};

export type VersionSummary = {
  version: number;
  parent: number | null;
  parents: number[];
  tags: string[];
  featured: boolean;
  favorite: boolean;
  hidden: boolean;
  reachable: boolean;
  created_at: string;
  actor: string;
  change_note: string;
  digest: string;
  prompt_excerpt: string;
  preview_url: string | null;
};

export type VersionDetail = VersionSummary & {
  prompt: string;
  negative: string;
  notes: string;
  model: string;
  params: string;
  assets: AssetGroups;
};

export type RepresentativeVersion = {
  version: number;
  change_note: string;
  preview_url: string | null;
};

export type Theme = {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  starred: boolean;
  archived: boolean;
  prompt: string;
  negative: string;
  notes: string;
  model: string;
  params: string;
  assets: AssetGroups;
  dirty: boolean;
  working_base: number | null;
  current_version: number | null;
  version_count: number;
  can_create_root: boolean;
  versions: VersionSummary[];
  representative_versions: RepresentativeVersion[];
  has_favorite_versions: boolean;
  updated_at: string;
};

export type Comparison = {
  left: VersionDetail;
  right: VersionDetail;
  diffs: Record<"prompt" | "negative" | "notes", string>;
  metadata_changes: Array<{ field: string; left: string; right: string }>;
};

export type ThemeFilter = "active" | "archived" | "favorite" | "all";
export type CanvasMode = "pan" | "select";
export type EditorIntent = "overwrite" | "grow";

export type EditorDraft = {
  change_note: string;
  prompt: string;
  negative: string;
  notes: string;
  model: string;
  params: string;
  parents: number[];
};
