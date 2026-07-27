import { describe, expect, it } from "vitest";
import { ancestorsOf, normalizeParents, toGraphData } from "./graph-data";
import type { Theme, VersionSummary } from "./types";

const version = (id: number, parents: number[]): VersionSummary => ({
  version: id,
  parent: parents[0] ?? null,
  parents,
  tags: [],
  featured: false,
  favorite: false,
  hidden: false,
  reachable: true,
  created_at: "",
  actor: "user",
  change_note: `Node ${id}`,
  digest: `${id}`.padStart(64, "0"),
  prompt_excerpt: `prompt ${id}`,
  preview_url: null,
});

describe("DAG data", () => {
  it("retains every parent and allocates separate target ports", () => {
    const theme = {
      versions: [version(3, [1, 2]), version(2, [1]), version(1, [])],
      dirty: false,
    } as Theme;
    const graph = toGraphData(theme);
    expect(graph.edges.filter((edge) => edge.target === "version-3")).toMatchObject([
      { source: "version-1", style: { targetPort: "in-0" } },
      { source: "version-2", style: { targetPort: "in-1" } },
    ]);
  });

  it("walks all upstream sources", () => {
    const versions = [version(4, [2, 3]), version(3, [1]), version(2, [1]), version(1, [])];
    expect([...ancestorsOf(versions, [4])].sort()).toEqual([1, 2, 3, 4]);
  });

  it("normalizes old single-parent nodes", () => {
    expect(normalizeParents({ parent: 7, parents: undefined as unknown as number[] })).toEqual([7]);
  });

  it("reroutes visible children through hidden ancestors", () => {
    const hidden = { ...version(2, [1]), hidden: true };
    const theme = {
      versions: [version(3, [2]), hidden, version(1, [])],
      dirty: false,
    } as Theme;
    expect(toGraphData(theme).edges).toMatchObject([
      { source: "version-1", target: "version-3" },
    ]);
  });

  it("reroutes a working draft through its hidden base", () => {
    const hidden = { ...version(2, [1, 3]), hidden: true };
    const theme = {
      versions: [version(3, []), hidden, version(1, [])],
      dirty: true,
      working_base: 2,
      prompt: "working prompt",
      model: "model",
      params: "{}",
      assets: { reference: [], result: [] },
    } as unknown as Theme;

    expect(toGraphData(theme).edges).toMatchObject([
      { source: "version-1", target: "working", style: { targetPort: "in-0" } },
      { source: "version-3", target: "working", style: { targetPort: "in-1" } },
    ]);
  });

  it("uses the digest prefix for unnamed nodes and applies display preferences", () => {
    const unnamed = { ...version(1, []), change_note: "", digest: "a1b2c3d4e5f6" };
    const theme = { versions: [unnamed], dirty: false } as Theme;
    const node = toGraphData(theme, { nodeWidth: 320, showPrompt: false }).nodes[0];

    expect(node.data).toMatchObject({ title: "a1b2c3", width: 320, showPrompt: false });
    expect(node.style?.size).toEqual([320, 390]);
  });
});
