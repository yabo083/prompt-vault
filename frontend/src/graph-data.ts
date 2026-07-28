import type { EdgeData, NodeData } from "@antv/g6";
import { defaultCarouselPreferences, type CarouselPreferences } from "./library-preferences";
import type { RevisionSummary, Theme } from "./types";

export type VaultNodeData = {
  version: number | null;
  working: boolean;
  title: string;
  prompt: string;
  model: string;
  params: string;
  preview: string | null;
  previewUrls: string[];
  carousel: CarouselPreferences;
  featured: boolean;
  favorite: boolean;
  dirty: boolean;
  width: number;
  showPrompt: boolean;
};

export type GraphDisplayOptions = {
  autoFit?: boolean;
  initialZoom?: number;
  nodeWidth?: number;
  showPrompt?: boolean;
  carousel?: CarouselPreferences;
};

export function revisionId(revision: number) {
  return `revision-${revision}`;
}

export function normalizeParents(revision: Pick<RevisionSummary, "parentIds">) {
  return revision.parentIds;
}

export function graphStructureSignature(theme: Theme, options: GraphDisplayOptions = {}) {
  return JSON.stringify([
    theme.revisions.map((revision) => [revision.id, revision.parentIds, revision.hidden]),
    theme.hasUnsavedChanges,
    theme.baseRevision,
    options.nodeWidth,
    options.showPrompt,
  ]);
}

export function ancestorsOf(revisions: RevisionSummary[], selected: number[]) {
  const parents = new Map(revisions.map((revision) => [revision.id, normalizeParents(revision)]));
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
  const carousel = options.carousel || defaultCarouselPreferences;
  const initialNodeHeight = nodeWidth + (showPrompt ? 124 : 70);
  const allRevisions = new Map(theme.revisions.map((revision) => [revision.id, revision]));
  const revisions = [...theme.revisions].reverse().filter((revision) => !revision.hidden);
  const visible = new Set(revisions.map((revision) => revision.id));
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
        const hiddenParent = allRevisions.get(parent);
        if (hiddenParent) pending.push(...normalizeParents(hiddenParent));
      }
    }
    return [...resolved];
  };
  const resolvedParents = new Map(
    revisions.map((revision) => [revision.id, resolveVisibleParents(normalizeParents(revision))]),
  );
  const parentCounts = new Map(revisions.map((revision) => [revision.id, resolvedParents.get(revision.id)!.length]));
  const nodes: NodeData[] = revisions.map((revision) => ({
    id: revisionId(revision.id),
    data: {
      version: revision.id,
      working: false,
      title: revision.note || revision.digest.slice(0, 6),
      prompt: revision.promptExcerpt,
      model: "",
      params: "",
      preview: revision.previewUrl || null,
      previewUrls: revision.previewUrls,
      carousel,
      featured: revision.featured,
      favorite: revision.favorite,
      dirty: false,
      width: nodeWidth,
      showPrompt,
    } satisfies VaultNodeData,
    style: {
      size: [nodeWidth, initialNodeHeight],
      ports: [
        { key: "out", placement: "bottom", r: 0 },
        ...Array.from({ length: Math.max(1, parentCounts.get(revision.id) || 0) }, (_, index) => ({
          key: `in-${index}`,
          placement: [
            (index + 1) / (Math.max(1, parentCounts.get(revision.id) || 0) + 1),
            0,
          ] as [number, number],
          r: 0,
        })),
      ],
    },
  }));

  const edges: EdgeData[] = revisions.flatMap((revision) =>
    resolvedParents.get(revision.id)!.map((parent, index) => ({
      id: `edge-${parent}-${revision.id}-${index}`,
      source: revisionId(parent),
      target: revisionId(revision.id),
      data: { sourceVersion: parent, targetVersion: revision.id },
      style: { sourcePort: "out", targetPort: `in-${index}` },
    })),
  );

  if (theme.hasUnsavedChanges || revisions.length === 0) {
    const workingParents = theme.baseRevision == null ? [] : resolveVisibleParents([theme.baseRevision]);
    nodes.push({
      id: "working",
      data: {
        version: null,
        working: true,
        title: theme.workingTitle || (revisions.length ? "未保存 Draft" : "新 Draft"),
        prompt: theme.draft.prompt,
        model: theme.draft.model,
        params: theme.draft.params,
        preview: theme.draft.assets.result[0]?.url || theme.draft.assets.reference[0]?.url || null,
        previewUrls: theme.draft.assets.result.map((asset) => asset.url),
        carousel,
        featured: false,
        favorite: false,
        dirty: theme.hasUnsavedChanges,
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
        source: revisionId(parent),
        target: "working",
        data: { sourceVersion: parent, targetVersion: null },
        style: { sourcePort: "out", targetPort: `in-${index}`, lineDash: [5, 5] },
      });
    });
  }
  return { nodes, edges };
}
