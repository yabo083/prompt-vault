import { describe, expect, it } from "vitest";
import { nextThemeMode, normalizeThemeMode, resolveThemeMode } from "./theme-mode";

describe("theme mode", () => {
  it("defaults unknown persisted values to system while preserving old explicit choices", () => {
    expect(normalizeThemeMode(null)).toBe("system");
    expect(normalizeThemeMode("broken")).toBe("system");
    expect(normalizeThemeMode("light")).toBe("light");
    expect(normalizeThemeMode("dark")).toBe("dark");
  });

  it("cycles through system, light, and dark", () => {
    expect(nextThemeMode("system")).toBe("light");
    expect(nextThemeMode("light")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("system");
  });

  it("resolves system mode from the live color-scheme preference", () => {
    expect(resolveThemeMode("system", false)).toBe("light");
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
  });
});
