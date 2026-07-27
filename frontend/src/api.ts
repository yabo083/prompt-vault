import type { Comparison, EditorDraft, Theme, VersionDetail } from "./types";

export type AssetOrderEntry = { source: "existing" | "upload"; index: number };

const tokenKey = "prompt-vault-token";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getStoredToken() {
  return localStorage.getItem(tokenKey) || "";
}

export function setStoredToken(token: string) {
  if (token) {
    localStorage.setItem(tokenKey, token);
    document.cookie = `prompt_vault_token=${encodeURIComponent(token)}; Path=/; SameSite=Strict`;
  } else {
    localStorage.removeItem(tokenKey);
    document.cookie = "prompt_vault_token=; Path=/; Max-Age=0; SameSite=Strict";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { "X-Vault-Token": token } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.message || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  themes: (query = "") => request<Theme[]>(`/api/themes?q=${encodeURIComponent(query)}`),
  theme: (slug: string) => request<Theme>(`/api/themes/${encodeURIComponent(slug)}`),
  createTheme: (data: Partial<Theme>) =>
    request<Theme>("/api/themes", { method: "POST", body: JSON.stringify(data) }),
  updateTheme: (slug: string, data: Partial<Theme>) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify(data) }),
  duplicateTheme: (slug: string) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}/duplicate`, { method: "POST" }),
  toggleArchive: (slug: string) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}/archive`, { method: "POST" }),
  toggleThemeStar: (slug: string) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}/star`, { method: "POST" }),
  version: (slug: string, version: number) =>
    request<VersionDetail>(`/api/themes/${encodeURIComponent(slug)}/versions/${version}`),
  overwriteVersion: (
    slug: string,
    version: number,
    draft: EditorDraft,
    files: { reference: File[]; result: File[] },
    assetOrder: { reference: AssetOrderEntry[]; result: AssetOrderEntry[] },
  ) => {
    const form = new FormData();
    form.set("draft", JSON.stringify({
      ...draft,
      reference_order: assetOrder.reference,
      result_order: assetOrder.result,
    }));
    files.reference.forEach((file) => form.append("reference_files", file));
    files.result.forEach((file) => form.append("result_files", file));
    return request<Theme>(`/api/themes/${encodeURIComponent(slug)}/versions/${version}`, {
      method: "PUT",
      body: form,
    });
  },
  commit: (slug: string, draft: EditorDraft) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}/commits`, {
      method: "POST",
      body: JSON.stringify({ message: draft.change_note, parents: draft.parents }),
    }),
  grow: (
    slug: string,
    draft: EditorDraft,
    files: { reference: File[]; result: File[] },
    assetOrder: { reference: AssetOrderEntry[]; result: AssetOrderEntry[] },
    force = false,
  ) => {
    const form = new FormData();
    form.set("draft", JSON.stringify({ ...draft, force, reference_order: assetOrder.reference, result_order: assetOrder.result }));
    files.reference.forEach((file) => form.append("reference_files", file));
    files.result.forEach((file) => form.append("result_files", file));
    return request<Theme>(`/api/themes/${encodeURIComponent(slug)}/grow`, { method: "POST", body: form });
  },
  checkoutVersion: (slug: string, version: number, force = false) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}/versions/${version}/checkout`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),
  discardWorking: (slug: string) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}/discard`, { method: "POST" }),
  markVersion: (slug: string, version: number, marks: Record<string, boolean>) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}/versions/${version}/marks`, {
      method: "POST",
      body: JSON.stringify(marks),
    }),
  uploadAssets: (slug: string, kind: "reference" | "result", files: File[]) => {
    const form = new FormData();
    form.set("kind", kind);
    files.forEach((file) => form.append("files", file));
    return request<Theme>(`/api/themes/${encodeURIComponent(slug)}/assets`, { method: "POST", body: form });
  },
  deleteVersion: (slug: string, version: number) =>
    request<Theme>(`/api/themes/${encodeURIComponent(slug)}/versions/${version}`, { method: "DELETE" }),
  compare: (slug: string, left: number, right: number) =>
    request<Comparison>(`/api/themes/${encodeURIComponent(slug)}/compare?left=${left}&right=${right}`),
};
