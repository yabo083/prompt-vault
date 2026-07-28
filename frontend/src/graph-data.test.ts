import { describe, expect, it } from "vitest";
import { ancestorsOf, graphStructureSignature, normalizeParents, toGraphData } from "./graph-data";
import type { RevisionSummary, Theme } from "./types";

const revision = (id: number, parentIds: number[]): RevisionSummary => ({
  id,
  parentIds,
  featured: false,
  favorite: false,
  hidden: false,
  createdAt: "",
  actor: "user",
  note: `Revision ${id}`,
  digest: `${id}`.padStart(64, "0"),
  promptExcerpt: `prompt ${id}`,
  previewUrl: null,
  previewUrls: [],
});

describe("DAG data", () => {
  it("retains every parent and allocates separate target ports", () => {
    const theme = {
      revisions: [revision(3, [1, 2]), revision(2, [1]), revision(1, [])],
      hasUnsavedChanges: false,
    } as Theme;
    const graph = toGraphData(theme);
    expect(graph.edges.filter((edge) => edge.target === "revision-3")).toMatchObject([
      { source: "revision-1", style: { targetPort: "in-0" } },
      { source: "revision-2", style: { targetPort: "in-1" } },
    ]);
  });

  it("walks all upstream sources", () => {
    const revisions = [revision(4, [2, 3]), revision(3, [1]), revision(2, [1]), revision(1, [])];
    expect([...ancestorsOf(revisions, [4])].sort()).toEqual([1, 2, 3, 4]);
  });

  it("normalizes old single-parent nodes", () => {
    expect(normalizeParents({ parentIds: [7] })).toEqual([7]);
  });

  it("reroutes visible children through hidden ancestors", () => {
    const hidden = { ...revision(2, [1]), hidden: true };
    const theme = {
      revisions: [revision(3, [2]), hidden, revision(1, [])],
      hasUnsavedChanges: false,
    } as Theme;
    expect(toGraphData(theme).edges).toMatchObject([
      { source: "revision-1", target: "revision-3" },
    ]);
  });

  it("reroutes a working draft through its hidden base", () => {
    const hidden = { ...revision(2, [1, 3]), hidden: true };
    const theme = {
      revisions: [revision(3, []), hidden, revision(1, [])],
      hasUnsavedChanges: true,
      baseRevision: 2,
      draft: { prompt: "working prompt", model: "model", params: "{}", assets: { reference: [], result: [] } },
    } as unknown as Theme;

    expect(toGraphData(theme).edges).toMatchObject([
      { source: "revision-1", target: "working", style: { targetPort: "in-0" } },
      { source: "revision-3", target: "working", style: { targetPort: "in-1" } },
    ]);
  });

  it("uses the digest prefix for unnamed nodes and applies display preferences", () => {
    const unnamed = { ...revision(1, []), note: "", digest: "a1b2c3d4e5f6" };
    const theme = { revisions: [unnamed], hasUnsavedChanges: false } as Theme;
    const node = toGraphData(theme, { nodeWidth: 320, showPrompt: false }).nodes[0];

    expect(node.data).toMatchObject({ title: "a1b2c3", width: 320, showPrompt: false });
    expect(node.style?.size).toEqual([320, 390]);
  });

  it("passes every revision and Draft image to its node carousel", () => {
    const withImages = { ...revision(1, []), previewUrl: "/revision-a.png", previewUrls: ["/revision-a.png", "/revision-b.png"] };
    const theme = {
      revisions: [withImages],
      hasUnsavedChanges: true,
      baseRevision: 1,
      draft: {
        prompt: "working prompt",
        model: "model",
        params: "{}",
        assets: {
          result: [{ url: "/draft-result.png" }],
          reference: [{ url: "/draft-reference.png" }],
        },
      },
    } as unknown as Theme;

    const nodes = toGraphData(theme).nodes;
    expect(nodes.find((node) => node.id === "revision-1")?.data).toMatchObject({
      previewUrls: ["/revision-a.png", "/revision-b.png"],
    });
    expect(nodes.find((node) => node.id === "working")?.data).toMatchObject({
      previewUrls: ["/draft-result.png"],
    });
  });

  it("keeps display-only changes out of the graph structure signature", () => {
    const base = {
      revisions: [revision(1, [])],
      hasUnsavedChanges: true,
      baseRevision: 1,
      workingTitle: "Before",
    } as Theme;
    const signature = graphStructureSignature(base, { nodeWidth: 260, showPrompt: true });
    expect(graphStructureSignature({
      ...base,
      workingTitle: "After",
      revisions: [{ ...base.revisions[0], note: "Renamed", previewUrls: ["/new.png"] }],
    }, { nodeWidth: 260, showPrompt: true, carousel: { autoplay: false, delayMs: 5000, pauseOnHover: true, loop: false } })).toBe(signature);
    expect(graphStructureSignature(base, { nodeWidth: 320, showPrompt: true })).not.toBe(signature);
  });
});
