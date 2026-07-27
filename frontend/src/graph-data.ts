import type { EdgeData, NodeData } from "@antv/g6";
import type { Theme, VersionSummary } from "./types";

export type VaultNodeData = {
  version: number | null;
  working: boolean;
  title: string;
  prompt: string;
  model: string;
  params: string;
  preview: string | null;
  featured: boolean;
  favorite: boolean;
  dirty: boolean;
  width: number;
  showPrompt: boolean;
};

export type GraphDisplayOptions = {
  nodeWidth?: number;
  showPrompt?: boolean;
};

export function versionId(version: number) {
  return `version-${version}`;
}

export function normalizeParents(version: Pick<VersionSummary, "parent" | "parents">) {
  if (Array.isArray(version.parents)) return version.parents;
  return version.parent == null ? [] : [version.parent];
}

export function ancestorsOf(versions: VersionSummary[], selected: number[]) {
  const parents = new Map(versions.map((version) => [version.version, normalizeParents(version)]));
  const lineage = new Set<number>();
  const pending = [...selected];
  while (pending.length) {
    const version = pending.pop()!;
    if (lineage.has(version)) continue;
    lineage.add(version);
    pending.push(...(parents.get(version) || []));
  }
  return lineage;
}

export function toGraphData(theme: Theme, options: GraphDisplayOptions = {}): { nodes: NodeData[]; edges: EdgeData[] } {
  const nodeWidth = options.nodeWidth || 260;
  const showPrompt = options.showPrompt !== false;
  const initialNodeHeight = nodeWidth + (showPrompt ? 124 : 70);
  const allVersions = new Map(theme.versions.map((version) => [version.version, version]));
  const versions = [...theme.versions].reverse().filter((version) => !version.hidden);
  const visible = new Set(versions.map((version) => version.version));
  const resolveVisibleParents = (parents: number[]) => {
    const resolved = new Set<number>();
    const pending = [...parents];
    const visited = new Set<number>();
    while (pending.length) {
      const parent = pending.shift()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      if (visible.has(parent)) resolved.add(parent);
      else {
        const hiddenParent = allVersions.get(parent);
        if (hiddenParent) pending.push(...normalizeParents(hiddenParent));
      }
    }
    return [...resolved];
  };
  const resolvedParents = new Map(
    versions.map((version) => [version.version, resolveVisibleParents(normalizeParents(version))]),
  );
  const parentCounts = new Map(versions.map((version) => [version.version, resolvedParents.get(version.version)!.length]));
  const nodes: NodeData[] = versions.map((version) => ({
    id: versionId(version.version),
    data: {
      version: version.version,
      working: false,
      title: version.change_note || version.digest.slice(0, 6),
      prompt: version.prompt_excerpt,
      model: "",
      params: "",
      preview: version.preview_url,
      featured: version.featured,
      favorite: version.favorite,
      dirty: false,
      width: nodeWidth,
      showPrompt,
    } satisfies VaultNodeData,
    style: {
      size: [nodeWidth, initialNodeHeight],
      ports: [
        { key: "out", placement: "bottom", r: 0 },
        ...Array.from({ length: Math.max(1, parentCounts.get(version.version) || 0) }, (_, index) => ({
          key: `in-${index}`,
          placement: [
            (index + 1) / (Math.max(1, parentCounts.get(version.version) || 0) + 1),
            0,
          ] as [number, number],
          r: 0,
        })),
      ],
    },
  }));

  const edges: EdgeData[] = versions.flatMap((version) =>
    resolvedParents.get(version.version)!.map((parent, index) => ({
      id: `edge-${parent}-${version.version}-${index}`,
      source: versionId(parent),
      target: versionId(version.version),
      data: { sourceVersion: parent, targetVersion: version.version },
      style: { sourcePort: "out", targetPort: `in-${index}` },
    })),
  );

  if (theme.dirty || versions.length === 0) {
    const workingParents = theme.working_base == null ? [] : resolveVisibleParents([theme.working_base]);
    nodes.push({
      id: "working",
      data: {
        version: null,
        working: true,
        title: versions.length ? "未保存节点" : "新节点",
        prompt: theme.prompt,
        model: theme.model,
        params: theme.params,
        preview: theme.assets.result[0]?.url || theme.assets.reference[0]?.url || null,
        featured: false,
        favorite: false,
        dirty: theme.dirty,
        width: nodeWidth,
        showPrompt,
      } satisfies VaultNodeData,
      style: {
        size: [nodeWidth, initialNodeHeight],
        ports: [
          { key: "out", placement: "bottom", r: 0 },
          ...Array.from({ length: Math.max(1, workingParents.length) }, (_, index) => ({
            key: `in-${index}`,
            placement: [(index + 1) / (Math.max(1, workingParents.length) + 1), 0] as [number, number],
            r: 0,
          })),
        ],
      },
    });
    workingParents.forEach((parent, index) => {
      edges.push({
        id: `edge-${parent}-working-${index}`,
        source: versionId(parent),
        target: "working",
        data: { sourceVersion: parent, targetVersion: null },
        style: { sourcePort: "out", targetPort: `in-${index}`, lineDash: [5, 5] },
      });
    });
  }
  return { nodes, edges };
}
