export type WorkspacePreferences = {
  autoFit: boolean;
  initialZoom: number;
  nodeWidth: number;
  showPrompt: boolean;
};

export const defaultWorkspacePreferences: WorkspacePreferences = {
  autoFit: true,
  initialZoom: 1,
  nodeWidth: 260,
  showPrompt: true,
};

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

export function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences {
  const candidate = value && typeof value === "object" ? value as Partial<WorkspacePreferences> : {};
  return {
    autoFit: typeof candidate.autoFit === "boolean" ? candidate.autoFit : defaultWorkspacePreferences.autoFit,
    initialZoom: finiteNumber(candidate.initialZoom, defaultWorkspacePreferences.initialZoom, 0.5, 1.5),
    nodeWidth: finiteNumber(candidate.nodeWidth, defaultWorkspacePreferences.nodeWidth, 220, 360),
    showPrompt: typeof candidate.showPrompt === "boolean" ? candidate.showPrompt : defaultWorkspacePreferences.showPrompt,
  };
}

export function loadWorkspacePreferences(slug: string): WorkspacePreferences {
  try {
    return normalizeWorkspacePreferences(JSON.parse(localStorage.getItem(`prompt-vault-workspace:${slug}`) || "{}"));
  } catch {
    return defaultWorkspacePreferences;
  }
}

export function saveWorkspacePreferences(slug: string, preferences: WorkspacePreferences) {
  localStorage.setItem(`prompt-vault-workspace:${slug}`, JSON.stringify(normalizeWorkspacePreferences(preferences)));
}
