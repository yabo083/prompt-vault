// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { loadWorkspacePreferences, normalizeWorkspacePreferences, saveWorkspacePreferences } from "./workspace-preferences";

describe("workspace preferences", () => {
  it("keeps valid persisted canvas settings", () => {
    expect(normalizeWorkspacePreferences({ autoFit: false, initialZoom: 0.7, nodeWidth: 240, showPrompt: false }))
      .toEqual({ autoFit: false, initialZoom: 0.7, nodeWidth: 240, showPrompt: false });
  });

  it("replaces corrupt values and clamps numeric settings before G6 sees them", () => {
    expect(normalizeWorkspacePreferences({ autoFit: "yes", initialZoom: Number.NaN, nodeWidth: 900, showPrompt: null }))
      .toEqual({ autoFit: true, initialZoom: 1, nodeWidth: 360, showPrompt: true });
  });

  it("round-trips settings through localStorage across a reload", () => {
    localStorage.clear();
    saveWorkspacePreferences("test", { autoFit: false, initialZoom: 0.6, nodeWidth: 300, showPrompt: false });
    expect(loadWorkspacePreferences("test"))
      .toEqual({ autoFit: false, initialZoom: 0.6, nodeWidth: 300, showPrompt: false });
  });
});
