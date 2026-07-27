type ViewportGraph = {
  getPosition: () => ArrayLike<number>;
  getZoom: () => number;
};

type PositionedGraph = {
  getElementPosition: (id: string) => ArrayLike<number>;
};

export type ReactOverlayEdge = {
  id: string;
  source: string;
  target: string;
  state?: "lineage" | "dimmed";
};

export function syncReactNodeViewport(container: HTMLElement, graph: ViewportGraph) {
  const htmlLayer = container.querySelector<HTMLElement>(".version-node")?.parentElement?.parentElement;
  if (!htmlLayer) return false;
  const position = graph.getPosition();
  const x = position[0];
  const y = position[1];
  const zoom = graph.getZoom();
  htmlLayer.style.transformOrigin = "left top";
  htmlLayer.style.setProperty("--g6-zoom", String(zoom));
  (htmlLayer.style as CSSStyleDeclaration & { zoom: string }).zoom = "";
  htmlLayer.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  return true;
}

export function syncReactNodePositions(container: HTMLElement, graph: PositionedGraph) {
  container.querySelectorAll<HTMLElement>(".version-node").forEach((node) => {
    const version = node.dataset.version;
    const id = version === "working" ? "working" : version ? `version-${version}` : "";
    const wrapper = node.parentElement;
    if (!id || !wrapper) return;
    const position = graph.getElementPosition(id);
    wrapper.style.transform = `matrix(1, 0, 0, 1, ${position[0]}, ${position[1]})`;
  });
}

export function syncReactEdges(container: HTMLElement, graph: PositionedGraph, edges: ReactOverlayEdge[]) {
  const htmlLayer = container.querySelector<HTMLElement>(".version-node")?.parentElement?.parentElement;
  if (!htmlLayer) return false;
  let svg = htmlLayer.querySelector<SVGSVGElement>(":scope > .react-edge-layer");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("react-edge-layer");
    svg.setAttribute("aria-hidden", "true");
    htmlLayer.prepend(svg);
  }
  const nodes = new Map<string, { x: number; y: number; width: number; height: number }>();
  container.querySelectorAll<HTMLElement>(".version-node").forEach((node) => {
    const version = node.dataset.version;
    const id = version === "working" ? "working" : version ? `version-${version}` : "";
    const wrapper = node.parentElement;
    if (!id || !wrapper) return;
    const matrix = wrapper.style.transform.match(/^matrix\(([^)]+)\)$/)?.[1].split(",").map(Number);
    const position = matrix?.length === 6 && matrix.every(Number.isFinite)
      ? [matrix[4], matrix[5]]
      : graph.getElementPosition(id);
    const width = node.offsetWidth || Number.parseFloat(wrapper.style.width);
    const height = node.offsetHeight || Number.parseFloat(wrapper.style.height);
    nodes.set(id, { x: position[0], y: position[1], width, height });
  });
  const fragment = document.createDocumentFragment();
  edges.forEach((edge) => {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) return;
    const x1 = source.x + source.width / 2;
    const y1 = source.y + source.height;
    const x2 = target.x + target.width / 2;
    const y2 = target.y;
    const middleY = (y1 + y2) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.dataset.edgeId = edge.id;
    path.setAttribute("class", ["react-edge", edge.state].filter(Boolean).join(" "));
    path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`);
    fragment.append(path);
  });
  svg.replaceChildren(fragment);
  return true;
}
