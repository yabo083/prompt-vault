import { describe, expect, it } from "vitest";
import { fitCanvasText } from "./share-card-text";

function fakeContext() {
  return {
    font: "",
    measureText(text: string) {
      const fontSize = Number.parseFloat(this.font) || 16;
      const width = Array.from(text).reduce((total, character) => total + fontSize * (/^[\x00-\xff]$/.test(character) ? 0.6 : 1), 0);
      return { width };
    },
  } as CanvasRenderingContext2D;
}

describe("share card prompt layout", () => {
  it("fits the complete prompt into compact layout without ellipsis", () => {
    const prompt = Array.from({ length: 220 }, (_, index) => `subject ${index}, detailed lighting, cinematic composition`).join(", ");
    const fitted = fitCanvasText(fakeContext(), prompt, {
      maxWidth: 820,
      maxHeight: 390,
      maxFontSize: 13,
      minFontSize: 4.5,
      lineHeightRatio: 1.3,
      fontFamily: "Consolas",
    });

    expect(fitted.fits).toBe(true);
    expect(fitted.lines.join("")).toBe(prompt);
    expect(fitted.lines.join("")).not.toContain("...");
  });

  it("continues shrinking instead of returning clipped text for extreme prompts", () => {
    const prompt = "detailed subject, cinematic lighting, ".repeat(3_000).trim();
    const fitted = fitCanvasText(fakeContext(), prompt, {
      maxWidth: 820,
      maxHeight: 390,
      maxFontSize: 13,
      minFontSize: 0.5,
      lineHeightRatio: 1.3,
      fontFamily: "Consolas",
    });

    expect(fitted.fits).toBe(true);
    expect(fitted.lines.join("")).toBe(prompt);
  });
});
