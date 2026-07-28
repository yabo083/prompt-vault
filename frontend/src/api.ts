import type { Asset, Comparison, Revision, RevisionSummary, Theme } from "./types";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error?.message || payload.message || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function connectBrowser(token: string) {
  return request<void>("/api/v2/auth/browser", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function revisionAssetUrl(slug: string, revisionId: number, digest: string, kind: "reference" | "result", name: string) {
  return `/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}/assets/${kind}/${encodeURIComponent(name)}?v=${encodeURIComponent(digest)}`;
}

function decorateAssets(slug: string, assets: Omit<Asset, "url">[], kind: "reference" | "result", revisionId?: number, digest?: string): Asset[] {
  return assets.map((asset) => ({
    ...asset,
    url: revisionId === undefined
      ? `/api/v2/themes/${encodeURIComponent(slug)}/assets/${kind}/${encodeURIComponent(asset.name)}`
      : revisionAssetUrl(slug, revisionId, digest || "", kind, asset.name),
  }));
}

function decorateRevision(slug: string, revision: Omit<Revision, "draft"> & { draft: Omit<Revision["draft"], "assets"> & { assets: { reference: Omit<Asset, "url">[]; result: Omit<Asset, "url">[] } } }): Revision {
  return {
    ...revision,
    draft: {
      ...revision.draft,
      assets: {
        reference: decorateAssets(slug, revision.draft.assets.reference, "reference", revision.id, revision.digest),
        result: decorateAssets(slug, revision.draft.assets.result, "result", revision.id, revision.digest),
      },
    },
  };
}

type RawRevisionSummary = Omit<RevisionSummary, "previewUrl" | "previewUrls">;

type RawTheme = Omit<Theme, "draft" | "revisions" | "representativeRevisions" | "hasFavoriteRevisions"> & {
  draft: Omit<Theme["draft"], "assets"> & { assets: { reference: Omit<Asset, "url">[]; result: Omit<Asset, "url">[] } };
  revisions: RawRevisionSummary[];
};

async function hydrateTheme(raw: RawTheme): Promise<Theme> {
  const revisions = raw.revisions.map((revision) => ({
    ...revision,
    previewUrl: revision.previewAsset ? revisionAssetUrl(raw.slug, revision.id, revision.digest, revision.previewAsset.kind, revision.previewAsset.name) : null,
    previewUrls: (revision.previewAssets || []).filter((asset) => asset.kind === "result")
      .map((asset) => revisionAssetUrl(raw.slug, revision.id, revision.digest, asset.kind, asset.name)),
  }));
  return {
    ...raw,
    draft: {
      ...raw.draft,
      assets: {
        reference: decorateAssets(raw.slug, raw.draft.assets.reference, "reference"),
        result: decorateAssets(raw.slug, raw.draft.assets.result, "result"),
      },
    },
    revisions,
    representativeRevisions: revisions.flatMap((revision) => {
      const previewResult = revision.previewAssets?.find((asset) => asset.kind === "result");
      return revision.featured && revision.previewUrls[0] && previewResult
        ? [{ id: revision.id, note: revision.note, previewUrl: revision.previewUrls[0], sha256: previewResult.sha256 }]
        : [];
    }),
    hasFavoriteRevisions: revisions.some((revision) => revision.favorite),
  };
}

async function theme(slug: string) {
  return hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}`));
}

export const api = {
  themes: async (query = "") => {
    const themes = await request<RawTheme[]>(`/api/v2/themes?detail=true&q=${encodeURIComponent(query)}`);
    return Promise.all(themes.map(hydrateTheme));
  },
  exportVault: () => request<unknown>("/api/v2/export"),
  theme,
  createTheme: async (data: Partial<Theme>) => hydrateTheme(await request<RawTheme>("/api/v2/themes", { method: "POST", body: JSON.stringify(data) })),
  updateDraft: async (slug: string, data: Record<string, unknown>) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/draft`, { method: "PATCH", body: JSON.stringify(data) })),
  applyDraftEdit: async (
    slug: string,
    edit: Record<string, unknown>,
    files: { reference: File[]; result: File[] },
  ) => {
    const form = new FormData();
    form.set("edit", JSON.stringify(edit));
    files.reference.forEach((file) => form.append("reference_files", file));
    files.result.forEach((file) => form.append("result_files", file));
    return hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/draft/apply`, { method: "POST", body: form }));
  },
  overwriteRevision: async (
    slug: string,
    revisionId: number,
    edit: Record<string, unknown>,
    files: { reference: File[]; result: File[] },
  ) => {
    const form = new FormData();
    form.set("edit", JSON.stringify(edit));
    files.reference.forEach((file) => form.append("reference_files", file));
    files.result.forEach((file) => form.append("result_files", file));
    return hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}`, { method: "PUT", body: form }));
  },
  duplicateTheme: async (slug: string) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/duplicate`, { method: "POST" })),
  deleteTheme: (slug: string) => request<void>(`/api/v2/themes/${encodeURIComponent(slug)}`, { method: "DELETE" }),
  setNodeTitle: async (slug: string, revisionId: number | null, title: string) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/nodes/${revisionId ?? "working"}/title`, { method: "PATCH", body: JSON.stringify({ title }) })),
  revision: async (slug: string, revisionId: number) => decorateRevision(slug, await request(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}`)),
  saveRevision: async (slug: string, input: { note?: string; parentIds?: number[] }) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/revisions`, { method: "POST", body: JSON.stringify(input) })),
  continueRevision: async (slug: string, revisionId: number, force = false) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}/continue`, { method: "POST", body: JSON.stringify({ force }) })),
  restoreRevision: async (slug: string, revisionId: number, force = false) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}/restore`, { method: "POST", body: JSON.stringify({ force }) })),
  discardDraft: async (slug: string) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/draft/discard`, { method: "POST" })),
  markRevision: async (slug: string, revisionId: number, marks: Record<string, boolean>) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}/marks`, { method: "PATCH", body: JSON.stringify(marks) })),
  uploadAssets: async (slug: string, kind: "reference" | "result", files: File[]) => {
    const form = new FormData();
    form.set("kind", kind);
    files.forEach((file) => form.append("files", file));
    return hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/assets`, { method: "POST", body: form }));
  },
  removeAsset: async (slug: string, kind: "reference" | "result", name: string) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/assets/${kind}/${encodeURIComponent(name)}`, { method: "DELETE" })),
  reorderAssets: async (slug: string, kind: "reference" | "result", names: string[]) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/assets/${kind}/order`, { method: "PUT", body: JSON.stringify({ names }) })),
  deleteRevision: async (slug: string, revisionId: number, force = false) => hydrateTheme(await request<RawTheme>(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/${revisionId}${force ? "?force=true" : ""}`, { method: "DELETE" })),
  compare: async (slug: string, left: number, right: number) => {
    const comparison = await request<Comparison>(`/api/v2/themes/${encodeURIComponent(slug)}/revisions/compare?left=${left}&right=${right}`);
    return { ...comparison, left: decorateRevision(slug, comparison.left), right: decorateRevision(slug, comparison.right) };
  },
};
