import { afterEach, describe, expect, it, vi } from "vitest";
import { api, revisionAssetUrl } from "./api";
import { buildCarouselSlides, usesCarousel } from "./library-preferences";

afterEach(() => vi.unstubAllGlobals());

describe("Revision Asset URLs", () => {
  it("changes the immutable URL when overwritten bytes change under the same filename", () => {
    const before = revisionAssetUrl("theme one", 3, "digest-before", "result", "same name.png");
    const after = revisionAssetUrl("theme one", 3, "digest-after", "result", "same name.png");

    expect(before).not.toBe(after);
    expect(after).toBe("/api/v2/themes/theme%20one/revisions/3/assets/result/same%20name.png?v=digest-after");
  });

  it("carries result hashes through hydration so duplicate Draft images stay static", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      slug: "single-image",
      title: "Single image",
      description: "",
      category: "Test",
      tags: [],
      starred: false,
      archived: false,
      updatedAt: "2026-07-28T00:00:00.000Z",
      baseRevision: 1,
      hasUnsavedChanges: false,
      revisionCount: 1,
      referenceUrls: [],
      workingTitle: "Draft",
      draft: {
        prompt: "prompt",
        negative: "",
        notes: "",
        model: "model",
        params: "",
        assets: { reference: [], result: [{ name: "same.png", sha256: "same-sha", size: 1, mime: "image/png" }] },
      },
      revisions: [{
        id: 1,
        parentIds: [],
        note: "Featured",
        actor: "test",
        createdAt: "2026-07-28T00:00:00.000Z",
        digest: "revision-digest",
        promptExcerpt: "prompt",
        featured: true,
        favorite: false,
        hidden: false,
        previewAsset: { kind: "result", name: "same.png", sha256: "same-sha" },
        previewAssets: [{ kind: "result", name: "same.png", sha256: "same-sha" }],
      }],
    }]), { headers: { "Content-Type": "application/json" } })));

    const [theme] = await api.themes();
    const slides = buildCarouselSlides({
      title: theme.title,
      representatives: theme.representativeRevisions,
      draftResults: theme.draft.assets.result.map((asset) => ({ previewUrl: asset.url, sha256: asset.sha256 })),
    }, true);

    expect(slides).toHaveLength(1);
    expect(usesCarousel(slides.map((slide) => slide.previewUrl))).toBe(false);
  });
});
