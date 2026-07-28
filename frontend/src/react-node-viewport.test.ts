// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { syncReactEdges, syncReactNodePositions, syncReactNodeViewport } from "./react-node-viewport";

describe("React node viewport synchronization", () => {
  it("applies the G6 camera to the HTML overlay without moving the graph container", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div class="html-layer"><div class="key"><div class="version-node"></div></div></div>';

    expect(syncReactNodeViewport(container, {
      getPosition: () => [737, -25, 0],
      getZoom: () => 0.8,
    })).toBe(true);
    expect((container.querySelector(".html-layer") as HTMLElement).style.transform)
      .toBe("translate(737px, -25px) scale(0.8)");
    expect((container.querySelector(".html-layer") as HTMLElement).style.getPropertyValue("--g6-zoom"))
      .toBe("0.8");
    expect((container.querySelector(".html-layer") as HTMLElement).style.zoom).toBe("");
    expect(container.style.transform).toBe("");
  });

  it("copies G6 model positions to React node wrappers", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div class="key"><div class="version-node" data-version="3"></div></div>';

    syncReactNodePositions(container, { getElementPosition: () => [420, 180, 0] });

    expect((container.querySelector(".key") as HTMLElement).style.transform)
      .toBe("matrix(1, 0, 0, 1, 420, 180)");
  });

  it("draws visible edges from current G6 positions instead of stale wrapper transforms", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div class="html-layer"><div class="key" style="width:260px;height:384px;transform:matrix(1, 0, 0, 1, 130, 192)"><div class="version-node" data-version="1"></div></div><div class="key" style="width:260px;height:384px;transform:matrix(1, 0, 0, 1, 130, 652)"><div class="version-node" data-version="4"></div></div></div>';
    const positions: Record<string, [number, number]> = { "revision-1": [420, 83], "revision-4": [420, 652] };

    expect(syncReactEdges(container, { getElementPosition: (id) => positions[id] }, [
      { id: "edge-1-4", source: "revision-1", target: "revision-4", state: "lineage" },
    ])).toBe(true);

    const svg = container.querySelector(".html-layer > .react-edge-layer");
    const path = svg?.querySelector("path");
    expect(svg).not.toBeNull();
    expect(path?.getAttribute("class")).toBe("react-edge lineage");
    expect(path?.getAttribute("d")).toBe("M 550 467 C 550 559.5, 550 559.5, 550 652");
  });
});
