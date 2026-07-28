// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { loadWorkspacePreferences, normalizeWorkspacePreferences, saveWorkspacePreferences } from "./workspace-preferences";

describe("workspace preferences", () => {
  it("keeps valid persisted canvas settings", () => {
    expect(normalizeWorkspacePreferences({
      autoFit: false,
      initialZoom: 0.7,
      nodeWidth: 240,
      showPrompt: false,
      carousel: { autoplay: false, delayMs: 4200, pauseOnHover: true, loop: false },
    })).toEqual({
      autoFit: false,
      initialZoom: 0.7,
      nodeWidth: 240,
      showPrompt: false,
      carousel: { autoplay: false, delayMs: 4200, pauseOnHover: true, loop: false },
    });
  });

  it("replaces corrupt values and clamps numeric settings before G6 sees them", () => {
    expect(normalizeWorkspacePreferences({
      autoFit: "yes",
      initialZoom: Number.NaN,
      nodeWidth: 900,
      showPrompt: null,
      carousel: { autoplay: "yes", delayMs: 99_000, pauseOnHover: null, loop: "yes" },
    })).toEqual({
      autoFit: true,
      initialZoom: 1,
      nodeWidth: 360,
      showPrompt: true,
      carousel: { autoplay: true, delayMs: 10_000, pauseOnHover: false, loop: true },
    });
  });

  it("round-trips settings through localStorage across a reload", () => {
    localStorage.clear();
    const preferences = {
      autoFit: false,
      initialZoom: 0.6,
      nodeWidth: 300,
      showPrompt: false,
      carousel: { autoplay: false, delayMs: 3600, pauseOnHover: true, loop: false },
    };
    saveWorkspacePreferences("test", preferences);
    expect(loadWorkspacePreferences("test")).toEqual(preferences);
  });
});
