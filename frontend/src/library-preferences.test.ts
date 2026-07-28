// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildCarouselSlides,
  carouselAutoplayOptions,
  defaultLibraryPreferences,
  loadLibraryPreferences,
  normalizeLibraryPreferences,
  saveLibraryPreferences,
  usesCarousel,
} from "./library-preferences";

describe("library carousel preferences", () => {
  it("uses stable autoplay defaults that ignore pointer hover", () => {
    expect(defaultLibraryPreferences).toEqual({
      autoplay: true,
      delayMs: 2800,
      pauseOnHover: false,
      loop: true,
      includeDraftAssets: true,
    });
  });

  it("normalizes persisted values before Embla receives them", () => {
    expect(normalizeLibraryPreferences({
      autoplay: "yes",
      delayMs: 99_000,
      pauseOnHover: true,
      loop: false,
      includeDraftAssets: null,
    })).toEqual({
      autoplay: true,
      delayMs: 10_000,
      pauseOnHover: true,
      loop: false,
      includeDraftAssets: true,
    });
  });

  it("round-trips the homepage settings through localStorage", () => {
    localStorage.clear();
    const preferences = { autoplay: false, delayMs: 4200, pauseOnHover: true, loop: false, includeDraftAssets: false };
    saveLibraryPreferences(preferences);
    expect(loadLibraryPreferences()).toEqual(preferences);
  });

  it("maps settings to Embla autoplay without custom pointer interference", () => {
    expect(carouselAutoplayOptions(defaultLibraryPreferences)).toMatchObject({
      active: true,
      delay: 2800,
      playOnInit: true,
      stopOnFocusIn: false,
      stopOnInteraction: false,
      stopOnMouseEnter: false,
      stopOnLastSnap: false,
    });
    expect(carouselAutoplayOptions({ ...defaultLibraryPreferences, pauseOnHover: true, loop: false })).toMatchObject({
      stopOnMouseEnter: true,
      stopOnLastSnap: true,
    });
  });

  it("includes and deduplicates Draft images only when configured", () => {
    const input = {
      title: "Theme",
      representatives: [{ id: 4, note: "Featured", previewUrl: "/featured.png?v=revision", sha256: "featured-sha" }],
      draftResults: [
        { previewUrl: "/draft-a.png", sha256: "draft-a-sha" },
        { previewUrl: "/featured.png", sha256: "featured-sha" },
      ],
    };

    expect(buildCarouselSlides(input, false).map((slide) => slide.previewUrl)).toEqual(["/featured.png?v=revision"]);
    expect(buildCarouselSlides(input, true).map((slide) => slide.previewUrl)).toEqual([
      "/featured.png?v=revision",
      "/draft-a.png",
    ]);
  });

  it("keeps one static slide when a featured Revision and Draft reference the same asset", () => {
    const slides = buildCarouselSlides({
      title: "Single image",
      representatives: [{ id: 1, note: "Featured", previewUrl: "/revision/image.png?v=abc", sha256: "same-sha" }],
      draftResults: [{ previewUrl: "/draft/image.png", sha256: "same-sha" }],
    }, true);

    expect(slides).toHaveLength(1);
    expect(usesCarousel(slides.map((slide) => slide.previewUrl))).toBe(false);
  });

  it("only creates a carousel when more than one generated image exists", () => {
    expect(usesCarousel([])).toBe(false);
    expect(usesCarousel(["/only-result.png"])).toBe(false);
    expect(usesCarousel(["/result-a.png", "/result-b.png"])).toBe(true);
  });
});
