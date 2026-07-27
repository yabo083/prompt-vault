import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CanvasEvent,
  ExtensionCategory,
  Graph,
  GraphEvent,
  NodeEvent,
  register,
  type EdgeData,
  type NodeData,
} from "@antv/g6";
import { ReactNode } from "@antv/g6-extension-react";
import { motion, Reorder, useDragControls, useReducedMotion } from "framer-motion";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import useEmblaCarousel from "embla-carousel-react";
import Autoplay from "embla-carousel-autoplay";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  Expand,
  FilePlus2,
  Focus,
  GitCompareArrows,
  Hand,
  Image as ImageIcon,
  KeyRound,
  LocateFixed,
  Maximize2,
  Menu,
  Moon,
  MousePointer2,
  Plus,
  Search,
  Settings,
  Share2,
  Sparkles,
  Star,
  Sun,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ApiError, api, getStoredToken, setStoredToken, type AssetOrderEntry } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Kbd } from "./components/ui/kbd";
import { Textarea } from "./components/ui/textarea";
import { ancestorsOf, toGraphData, type VaultNodeData, versionId } from "./graph-data";
import { approachZoom, availableViewportCenter, canSaveEditor, graphToViewportPoint, initialEditorIntent, nextEditorState, pointerClickAction, pointerDragAction, rectanglesIntersect, translationToCenter, viewportToGraphPoint, wheelDeltaPixels, wheelZoomTarget, type EditorSessionState } from "./interaction-state";
import { syncReactEdges, syncReactNodePositions, syncReactNodeViewport, type ReactOverlayEdge } from "./react-node-viewport";
import { loadWorkspacePreferences, saveWorkspacePreferences, type WorkspacePreferences } from "./workspace-preferences";
import type {
  Asset,
  CanvasMode,
  Comparison,
  EditorDraft,
  EditorIntent,
  Theme,
  ThemeFilter,
  VersionDetail,
} from "./types";

const ComparatorDiff = lazy(() => import("./ComparatorDiff"));

register(ExtensionCategory.NODE, "vault-react", ReactNode);

const emptyDraft: EditorDraft = {
  change_note: "",
  prompt: "",
  negative: "",
  notes: "",
  model: "",
  params: "",
  parents: [],
};

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button variant="ghost" size="icon" className="icon-button" aria-label={label} {...props}>{children}</Button>
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={8}>{label}</Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
  );
}

function useThemeMode() {
  const [mode, setMode] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("prompt-vault-theme");
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem("prompt-vault-theme", mode);
  }, [mode]);
  return [mode, setMode] as const;
}

function useMobileWorkspace() {
  const [mobile, setMobile] = useState(() => innerWidth <= 760);
  useEffect(() => {
    const update = () => setMobile(innerWidth <= 760);
    addEventListener("resize", update);
    return () => removeEventListener("resize", update);
  }, []);
  return mobile;
}

function RepresentativeCarousel({ theme }: { theme: Theme }) {
  const representatives = theme.representative_versions.filter((item) => item.preview_url);
  const fallback = theme.assets.result[0]?.url || theme.assets.reference[0]?.url || null;
  const slides = representatives.length ? representatives : fallback ? [{ version: 0, change_note: theme.title, preview_url: fallback }] : [];
  const autoplay = useRef(Autoplay({ delay: 1400, stopOnInteraction: false, rootNode: (root) => root.parentElement }));
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: slides.length > 1 }, [autoplay.current]);
  useEffect(() => { autoplay.current.stop(); }, []);

  if (!slides.length) {
    return <div className="theme-art empty-art"><ImageIcon size={24} /><span>PV</span></div>;
  }
  return (
    <div
      className="theme-art embla"
      ref={emblaRef}
      onMouseEnter={() => slides.length > 1 && autoplay.current.play()}
      onMouseLeave={() => { autoplay.current.stop(); emblaApi?.scrollTo(0); }}
    >
      <div className="embla-container">
        {slides.map((slide, index) => (
          <div className="embla-slide" key={`${slide.version}-${index}`}>
            <img src={slide.preview_url!} alt="" loading="lazy" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ThemeCard({ theme, onOpen }: { theme: Theme; onOpen: () => void }) {
  return (
    <button className="theme-card" onClick={onOpen}>
      <RepresentativeCarousel theme={theme} />
      <div className="theme-card-body">
        <div className="theme-card-title"><span>{theme.title}</span>{theme.starred && <Star size={14} fill="currentColor" />}</div>
        <p>{theme.description || theme.prompt || " "}</p>
        <div className="theme-card-meta"><span>{theme.version_count} 节点</span><span>{theme.category}</span></div>
      </div>
    </button>
  );
}

function Library({ onOpen, onUnauthorized }: { onOpen: (slug: string) => void; onUnauthorized: () => void }) {
  const [filter, setFilter] = useState<ThemeFilter>("active");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newTheme, setNewTheme] = useState({ title: "", prompt: "", description: "" });
  const queryClient = useQueryClient();
  const themesQuery = useQuery({ queryKey: ["themes", search], queryFn: () => api.themes(search) });
  const createMutation = useMutation({
    mutationFn: () => api.createTheme(newTheme),
    onSuccess: (theme) => {
      queryClient.invalidateQueries({ queryKey: ["themes"] });
      setCreateOpen(false);
      onOpen(theme.slug);
    },
  });
  useEffect(() => {
    if (themesQuery.error instanceof ApiError && themesQuery.error.status === 401) onUnauthorized();
  }, [themesQuery.error, onUnauthorized]);

  const themes = (themesQuery.data || []).filter((theme) => {
    if (filter === "active") return !theme.archived;
    if (filter === "archived") return theme.archived;
    if (filter === "favorite") return theme.starred || theme.has_favorite_versions;
    return true;
  });
  const filters: Array<[ThemeFilter, string]> = [["active", "迭代中"], ["archived", "已归档"], ["favorite", "收藏"], ["all", "全部"]];

  return (
    <main className="library-shell">
      <header className="library-header">
        <div className="wordmark"><span>PV</span><strong>Prompt Vault</strong></div>
        <div className="header-actions">
          <label className="search-field"><Search size={16} /><Input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索主题、标签或提示词" /></label>
          <Button onClick={() => setCreateOpen(true)}><Plus size={16} />新建主题</Button>
        </div>
      </header>
      <nav className="filter-tabs" aria-label="主题分类">
        {filters.map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
      </nav>
      <section className="theme-grid">
        {themes.map((theme) => <ThemeCard key={theme.slug} theme={theme} onOpen={() => onOpen(theme.slug)} />)}
      </section>
      {!themesQuery.isLoading && !themes.length && <div className="quiet-empty">没有符合当前条件的主题</div>}
      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content create-dialog">
            <Dialog.Title>新建主题</Dialog.Title>
            <Dialog.Description className="sr-only">创建一个独立的提示词探索主题。</Dialog.Description>
            <Dialog.Close asChild><button className="dialog-close" aria-label="关闭"><X size={18} /></button></Dialog.Close>
            <label>名称<Input autoFocus value={newTheme.title} onChange={(event) => setNewTheme({ ...newTheme, title: event.target.value })} /></label>
            <label>初始提示词<Textarea rows={7} value={newTheme.prompt} onChange={(event) => setNewTheme({ ...newTheme, prompt: event.target.value })} /></label>
            <label>描述<Input value={newTheme.description} onChange={(event) => setNewTheme({ ...newTheme, description: event.target.value })} /></label>
            <div className="dialog-actions"><Button disabled={!newTheme.title.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>创建</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

function VersionNodeCard({ data }: { data: VaultNodeData & { selected?: boolean; dimmed?: boolean; lineage?: boolean } }) {
  const className = ["version-node", data.working && "working", data.selected && "selected", data.dimmed && "dimmed", data.lineage && "lineage"].filter(Boolean).join(" ");
  return (
    <div className={className} data-version={data.version ?? "working"} style={{ "--node-width": `${data.width}px` } as CSSProperties}>
      <div className="node-image">
        {data.preview ? <img src={data.preview} alt="" draggable={false} /> : <div className="node-image-empty"><ImageIcon size={22} /></div>}
        <div className="node-flags">{data.featured && <Focus size={14} />}{data.favorite && <Star size={14} fill="currentColor" />}</div>
      </div>
      <div className="node-body">
        <div className="node-heading"><strong>{data.title}</strong><span>{data.working ? "LIVE" : `#${String(data.version).padStart(4, "0")}`}</span></div>
        {data.showPrompt && <p>{data.prompt || " "}</p>}
        <div className="node-params"><span>{data.model || "MODEL -"}</span>{data.dirty && <span className="dirty-mark">UNSAVED</span>}</div>
      </div>
    </div>
  );
}

type GraphEventLike = { target?: { id?: string }; nativeEvent?: MouseEvent; originalEvent?: MouseEvent; client?: { x: number; y: number } };
type ContextTarget = number | "working" | null;

function VersionCanvas({
  theme,
  selected,
  mode,
  preferences,
  zoom,
  recenterSignal,
  centerVersion,
  onSelected,
  onOpen,
  onBlank,
  onContext,
  onZoomChange,
}: {
  theme: Theme;
  selected: number[];
  mode: CanvasMode;
  preferences: WorkspacePreferences;
  zoom: number;
  recenterSignal: number;
  centerVersion: number | null | undefined;
  onSelected: (versions: number[]) => void;
  onOpen: (version: number | null) => void;
  onBlank: () => void;
  onContext: (version: ContextTarget) => void;
  onZoomChange: (zoom: number) => void;
}) {
  const graphData = toGraphData(theme, preferences);
  const graphContentKey = JSON.stringify([
    theme.updated_at,
    theme.dirty,
    theme.prompt,
    theme.model,
    theme.params,
    theme.assets,
    theme.versions,
    preferences.autoFit,
    preferences.initialZoom,
    preferences.nodeWidth,
    preferences.showPrompt,
  ]);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const reduceMotion = useReducedMotion();
  const [graphReady, setGraphReady] = useState(false);
  const pointerDragRef = useRef({ button: -1, pointerId: -1, startX: 0, startY: 0, x: 0, y: 0, moved: false, captured: false, nodeId: "", vx: 0, vy: 0, additive: false, initialSelected: [] as number[], selectionBox: null as HTMLDivElement | null });
  const zoomControllerRef = useRef<(target: number, origin?: [number, number]) => void>(() => undefined);
  const centerControllerRef = useRef<(version: number | null | undefined) => void>(() => undefined);
  const refreshControllerRef = useRef<() => void>(() => undefined);
  const cameraGenerationRef = useRef(0);
  const handledRecenterRef = useRef(0);
  const lastGraphContentKeyRef = useRef(graphContentKey);
  const selectedRef = useRef(selected);
  const modeRef = useRef(mode);
  const themeRef = useRef(theme);
  const graphDataRef = useRef(graphData);
  const preferencesRef = useRef(preferences);
  const zoomRef = useRef(zoom);
  const callbacks = useRef({ onSelected, onOpen, onBlank, onContext, onZoomChange });
  modeRef.current = mode;
  selectedRef.current = selected;
  themeRef.current = theme;
  graphDataRef.current = graphData;
  preferencesRef.current = preferences;
  zoomRef.current = zoom;
  callbacks.current = { onSelected, onOpen, onBlank, onContext, onZoomChange };
  const getOverlayEdges = (selection: number[]): ReactOverlayEdge[] => {
    const lineage = ancestorsOf(themeRef.current.versions, selection);
    return graphDataRef.current.edges.map((edge) => {
      const data = edge.data as { sourceVersion: number; targetVersion: number | null };
      const state = selection.length && data.targetVersion != null && lineage.has(data.sourceVersion) && lineage.has(data.targetVersion)
        ? "lineage" as const
        : selection.length ? "dimmed" as const : undefined;
      return { id: String(edge.id), source: String(edge.source), target: String(edge.target), state };
    });
  };

  useEffect(() => {
    if (!containerRef.current) return;
    setGraphReady(false);
    const graph = new Graph({
      container: containerRef.current,
      data: graphDataRef.current,
      zoomRange: [0.25, 3],
      animation: false,
      layout: { type: "dagre", rankdir: "TB", nodesep: 56, ranksep: 76, controlPoints: true },
      node: {
        type: "vault-react",
        style: {
          component: (datum: NodeData) => <VersionNodeCard data={datum.data as VaultNodeData} />,
        },
      },
      edge: {
        type: "cubic-vertical",
        style: { stroke: "transparent", lineWidth: 0, opacity: 0, endArrow: false, pointerEvents: "none" },
        state: {
          lineage: { opacity: 0 },
          dimmed: { opacity: 0 },
        },
      },
      behaviors: [],
    });
    let disposed = false;
    let viewportFrame = 0;
    let inertiaFrame = 0;
    let zoomFrame = 0;
    let transformFrame = 0;
    let zoomTransforming = false;
    let zoomGeneration = 0;
    let zoomTarget = zoomRef.current;
    let zoomOrigin: [number, number] | undefined;
    const container = containerRef.current;
    const syncHtmlGraph = () => {
      syncReactEdges(container, graph, getOverlayEdges(selectedRef.current));
    };
    const syncHtmlViewport = () => {
      if (disposed) return;
      cancelAnimationFrame(viewportFrame);
      viewportFrame = requestAnimationFrame(() => {
        if (disposed) return;
        syncReactNodeViewport(container, graph);
      });
    };
    const trackHtmlViewport = () => {
      if (disposed) return;
      syncReactNodeViewport(container, graph);
      transformFrame = requestAnimationFrame(trackHtmlViewport);
    };
    const onBeforeTransform = () => {
      if (disposed || transformFrame) return;
      transformFrame = requestAnimationFrame(trackHtmlViewport);
    };
    const onAfterTransform = () => {
      cancelAnimationFrame(transformFrame);
      transformFrame = 0;
      syncHtmlViewport();
      callbacks.current.onZoomChange(graph.getZoom());
    };
    const scheduleZoom = () => {
      if (disposed || zoomFrame || zoomTransforming || cameraGenerationRef.current !== zoomGeneration) return;
      zoomFrame = requestAnimationFrame(() => {
        zoomFrame = 0;
        if (disposed || cameraGenerationRef.current !== zoomGeneration) return;
        zoomTransforming = true;
        const nextZoom = reduceMotion ? zoomTarget : approachZoom(graph.getZoom(), zoomTarget);
        const anchorViewport = zoomOrigin;
        const currentPosition = graph.getPosition();
        const anchorGraph = anchorViewport ? viewportToGraphPoint(
          { x: anchorViewport[0], y: anchorViewport[1] },
          { x: currentPosition[0], y: currentPosition[1] },
          graph.getZoom(),
        ) : null;
        void graph.zoomTo(nextZoom, false)
          .then(() => {
            if (!anchorGraph || !anchorViewport || disposed || cameraGenerationRef.current !== zoomGeneration) return;
            const position = graph.getPosition();
            const shifted = graphToViewportPoint(
              anchorGraph,
              { x: position[0], y: position[1] },
              graph.getZoom(),
            );
            const correction = translationToCenter(
              shifted,
              { x: anchorViewport[0], y: anchorViewport[1] },
              graph.getZoom(),
            );
            if (Math.hypot(...correction) >= 0.01) return graph.translateBy(correction, false);
          })
          .then(() => {
            zoomTransforming = false;
            if (disposed || graphRef.current !== graph || cameraGenerationRef.current !== zoomGeneration) return;
            syncReactNodeViewport(container, graph);
            if (Math.abs(graph.getZoom() - zoomTarget) < 0.0005) {
              callbacks.current.onZoomChange(graph.getZoom());
              return;
            }
            scheduleZoom();
          })
          .catch(() => { zoomTransforming = false; });
      });
    };
    const queueZoom = (target: number, origin?: [number, number]) => {
      zoomGeneration = ++cameraGenerationRef.current;
      zoomTarget = Math.max(0.25, Math.min(3, target));
      const rect = container.getBoundingClientRect();
      zoomOrigin = origin || [rect.width / 2, rect.height / 2];
      scheduleZoom();
    };
    zoomControllerRef.current = queueZoom;
    const renderedCenter = (nodes: HTMLElement[]) => {
      const rects = nodes.map((node) => node.getBoundingClientRect());
      if (!rects.length) return null;
      const left = Math.min(...rects.map((rect) => rect.left));
      const right = Math.max(...rects.map((rect) => rect.right));
      const top = Math.min(...rects.map((rect) => rect.top));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return { x: (left + right) / 2, y: (top + bottom) / 2 };
    };
    const centerRenderedCards = async (version: number | null | undefined, animation: false | { duration: number; easing: string }) => {
      if (disposed) return;
      const selector = version === undefined ? ".version-node" : `.version-node[data-version="${version ?? "working"}"]`;
      const current = renderedCenter(Array.from(container.querySelectorAll<HTMLElement>(selector)));
      if (!current) return;
      const viewport = container.getBoundingClientRect();
      const editor = version === undefined ? null : document.querySelector<HTMLElement>(".editor-dialog")?.getBoundingClientRect();
      const target = availableViewportCenter(viewport, editor);
      const translation = translationToCenter(current, target, graph.getZoom());
      if (Math.hypot(...translation) < 0.5) return;
      await graph.translateBy(translation, animation);
    };
    centerControllerRef.current = (version) => {
      const generation = ++cameraGenerationRef.current;
      zoomTarget = graph.getZoom();
      cancelAnimationFrame(zoomFrame);
      zoomFrame = 0;
      const animation = reduceMotion ? false : { duration: 420, easing: "ease-in-out" };
      const waitForZoom = () => new Promise<void>((resolve) => {
        const check = () => zoomTransforming ? requestAnimationFrame(check) : resolve();
        check();
      });
      void waitForZoom()
        .then(() => {
          if (disposed || graphRef.current !== graph || cameraGenerationRef.current !== generation) return;
          return centerRenderedCards(version, animation);
        })
        .then(() => {
          if (disposed || graphRef.current !== graph || cameraGenerationRef.current !== generation) return;
          syncReactNodeViewport(container, graph);
        })
        .catch(() => undefined);
    };
    graph.on(GraphEvent.BEFORE_TRANSFORM, onBeforeTransform);
    graph.on(GraphEvent.AFTER_TRANSFORM, onAfterTransform);
    const measuredHeights = new Map<string, number>();
    let layoutTimer = 0;
    const nodeResizeObserver = new ResizeObserver((entries) => {
      if (disposed) return;
      const updates = entries.flatMap((entry) => {
        const node = entry.target as HTMLElement;
        const version = node.dataset.version;
        const id = version === "working" ? "working" : version ? `version-${version}` : "";
        const height = Math.round(node.offsetHeight);
        if (!id || !height || Math.abs((measuredHeights.get(id) || 0) - height) < 2) return [];
        measuredHeights.set(id, height);
        return [{ id, style: { size: [preferencesRef.current.nodeWidth, height] as [number, number] } }];
      });
      if (!updates.length) return;
      graph.updateNodeData(updates);
      clearTimeout(layoutTimer);
      const layoutCameraGeneration = cameraGenerationRef.current;
      layoutTimer = window.setTimeout(() => {
        if (disposed) return;
        void graph.layout()
          .then(() => disposed ? undefined : graph.draw())
          .then(() => {
            if (disposed) return;
            observeNodeSizes();
            syncHtmlGraph();
            syncHtmlViewport();
            if (cameraGenerationRef.current === layoutCameraGeneration) return focusGraph(layoutCameraGeneration);
          })
          .catch(() => undefined);
      }, 60);
    });
    const observeNodeSizes = () => container.querySelectorAll<HTMLElement>(".version-node").forEach((node) => nodeResizeObserver.observe(node));
    const releasePointer = (event: PointerEvent) => {
      try {
        if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      } catch { /* Pointer capture may already have ended outside the window. */ }
    };
    const removeSelectionBox = () => {
      pointerDragRef.current.selectionBox?.remove();
      pointerDragRef.current.selectionBox = null;
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (pointerDragRef.current.pointerId !== event.pointerId) return;
      releasePointer(event);
      removeSelectionBox();
      pointerDragRef.current = { button: -1, pointerId: -1, startX: 0, startY: 0, x: 0, y: 0, moved: false, captured: false, nodeId: "", vx: 0, vy: 0, additive: false, initialSelected: [], selectionBox: null };
    };
    const onPointerDown = (event: PointerEvent) => {
      cancelAnimationFrame(inertiaFrame);
      const target = event.target instanceof Element ? event.target : null;
      const version = target?.closest<HTMLElement>(".version-node")?.dataset.version;
      const nodeId = version === "working" ? "working" : version ? `version-${version}` : "";
      pointerDragRef.current = { button: event.button, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, captured: false, nodeId, vx: 0, vy: 0, additive: event.ctrlKey || event.metaKey, initialSelected: [...selectedRef.current], selectionBox: null };
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      const buttonMask = drag.button === 0 ? 1 : drag.button === 2 ? 2 : 0;
      if (!buttonMask || !(event.buttons & buttonMask)) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!dx && !dy) return;
      const brushOwned = modeRef.current === "select" && drag.button === 0;
      if (brushOwned) {
        if (!drag.moved) {
          if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4) return;
          drag.moved = true;
          try {
            container.setPointerCapture(event.pointerId);
            drag.captured = true;
          } catch { /* Synthetic pointer events have no active browser pointer. */ }
          drag.selectionBox = document.createElement("div");
          drag.selectionBox.className = "canvas-selection-box";
          container.append(drag.selectionBox);
        }
        drag.x = event.clientX;
        drag.y = event.clientY;
        const selection = {
          left: Math.min(drag.startX, drag.x),
          top: Math.min(drag.startY, drag.y),
          right: Math.max(drag.startX, drag.x),
          bottom: Math.max(drag.startY, drag.y),
        };
        const viewport = container.getBoundingClientRect();
        Object.assign(drag.selectionBox!.style, {
          left: `${selection.left - viewport.left}px`,
          top: `${selection.top - viewport.top}px`,
          width: `${selection.right - selection.left}px`,
          height: `${selection.bottom - selection.top}px`,
        });
        const matches = Array.from(container.querySelectorAll<HTMLElement>('.version-node:not([data-version="working"])'))
          .filter((node) => rectanglesIntersect(selection, node.getBoundingClientRect()))
          .map((node) => Number(node.dataset.version))
          .filter(Number.isFinite);
        callbacks.current.onSelected(drag.additive ? [...new Set([...drag.initialSelected, ...matches])] : matches);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const pointer = { targetType: drag.nodeId ? "node" : "canvas", button: drag.button, buttons: event.buttons };
      const action = pointerDragAction(modeRef.current, pointer);
      if (!action) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4) return;
        drag.moved = true;
        try {
          container.setPointerCapture(event.pointerId);
          drag.captured = true;
        } catch { /* Synthetic pointer events have no active browser pointer. */ }
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (action === "element" && drag.nodeId) {
        const zoom = graph.getZoom();
        void graph.translateElementBy(drag.nodeId, [dx / zoom, dy / zoom], false)
          .then(() => {
            if (disposed || graphRef.current !== graph) return;
            syncReactNodePositions(container, graph);
            syncHtmlGraph();
          });
      } else if (action === "canvas") {
        cameraGenerationRef.current += 1;
        const dampedX = dx * 0.82;
        const dampedY = dy * 0.82;
        drag.vx = drag.vx * 0.45 + dampedX * 0.55;
        drag.vy = drag.vy * 0.45 + dampedY * 0.55;
        const currentZoom = graph.getZoom();
        void graph.translateBy([dampedX * currentZoom, dampedY * currentZoom], false);
      }
    };
    const startCanvasInertia = (drag: typeof pointerDragRef.current) => {
      let vx = Math.max(-18, Math.min(18, drag.vx));
      let vy = Math.max(-18, Math.min(18, drag.vy));
      let travelled = 0;
      const tick = () => {
        if (disposed || travelled >= 120 || Math.hypot(vx, vy) < 0.35) return;
        const remaining = 120 - travelled;
        const distance = Math.hypot(vx, vy);
        const scale = distance > remaining ? remaining / distance : 1;
        const dx = vx * scale;
        const dy = vy * scale;
        travelled += Math.hypot(dx, dy);
        const currentZoom = graph.getZoom();
        void graph.translateBy([dx * currentZoom, dy * currentZoom], false);
        vx *= 0.78;
        vy *= 0.78;
        inertiaFrame = requestAnimationFrame(tick);
      };
      inertiaFrame = requestAnimationFrame(tick);
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag.pointerId !== event.pointerId) return;
      releasePointer(event);
      removeSelectionBox();
      if (modeRef.current === "select" && drag.button === 0 && drag.moved) return;
      const pointer = { targetType: drag.nodeId ? "node" : "canvas", button: drag.button, buttons: drag.button === 2 ? 2 : 1 };
      if (drag.moved && pointerDragAction(modeRef.current, pointer) === "canvas") startCanvasInertia(drag);
      if (drag.button !== 0 || drag.moved || !drag.nodeId) return;
      const version = drag.nodeId === "working" ? null : Number(drag.nodeId.replace("version-", ""));
      if (version != null && (event.ctrlKey || event.metaKey)) {
        const current = graph.getElementDataByState("node", "selected").map((item) => Number(String(item.id).replace("version-", ""))).filter(Number.isFinite);
        callbacks.current.onSelected(current.includes(version) ? current.filter((item) => item !== version) : [...current, version]);
        return;
      }
      callbacks.current.onSelected(version == null ? [] : [version]);
      callbacks.current.onOpen(version);
    };
    const onWheel = (event: WheelEvent) => {
      const delta = wheelDeltaPixels(event.deltaY, event.deltaMode, container.clientHeight);
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = container.getBoundingClientRect();
      queueZoom(wheelZoomTarget(zoomTarget, delta), [event.clientX - rect.left, event.clientY - rect.top]);
    };
    const onContextMenu = (event: MouseEvent) => {
      if (pointerDragRef.current.button === 2 && pointerDragRef.current.moved) {
        event.preventDefault();
        event.stopPropagation();
        pointerDragRef.current.moved = false;
        return;
      }
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".version-node") : null;
      if (target) callbacks.current.onContext(target.dataset.version === "working" ? "working" : Number(target.dataset.version));
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const action = pointerClickAction(pointerDragRef.current.moved, Boolean(target?.closest(".version-node")));
      if (action === "suppress") {
        event.preventDefault();
        event.stopPropagation();
        pointerDragRef.current.moved = false;
        return;
      }
      if (action === "node") {
        event.stopPropagation();
        return;
      }
      callbacks.current.onSelected([]);
      callbacks.current.onBlank();
    };
    container.addEventListener("pointerdown", onPointerDown, true);
    container.addEventListener("pointermove", onPointerMove, true);
    container.addEventListener("pointerup", onPointerUp, true);
    container.addEventListener("pointercancel", onPointerCancel, true);
    container.addEventListener("click", onClick, true);
    container.addEventListener("contextmenu", onContextMenu, true);
    container.addEventListener("wheel", onWheel, { capture: true, passive: false });
    graph.on(NodeEvent.CONTEXT_MENU, (rawEvent) => {
      const event = rawEvent as unknown as GraphEventLike;
      const id = event.target?.id || "";
      callbacks.current.onContext(id === "working" ? "working" : Number(id.replace("version-", "")));
    });
    graph.on(CanvasEvent.CONTEXT_MENU, () => callbacks.current.onContext(null));
    const focusGraph = async (expectedCameraGeneration = cameraGenerationRef.current) => {
      if (disposed || cameraGenerationRef.current !== expectedCameraGeneration) return;
      graph.resize();
      const currentPreferences = preferencesRef.current;
      if (disposed || cameraGenerationRef.current !== expectedCameraGeneration || !graphDataRef.current.nodes.length) return;
      const viewport = container.getBoundingClientRect();
      const origin: [number, number] = [viewport.width / 2, viewport.height / 2];
      if (currentPreferences.autoFit) {
        await graph.fitView({ when: "overflow" });
        if (disposed || cameraGenerationRef.current !== expectedCameraGeneration) return;
        if (graph.getZoom() > currentPreferences.initialZoom) await graph.zoomTo(currentPreferences.initialZoom, false, origin);
      } else {
        await graph.zoomTo(zoomRef.current, false, origin);
      }
      if (disposed || cameraGenerationRef.current !== expectedCameraGeneration) return;
      syncReactNodeViewport(container, graph);
      await centerRenderedCards(undefined, false);
      zoomTarget = graph.getZoom();
    };
    let refreshGeneration = 0;
    refreshControllerRef.current = () => {
      const generation = ++refreshGeneration;
      const refreshCameraGeneration = ++cameraGenerationRef.current;
      graph.setData(graphDataRef.current);
      void graph.draw()
        .then(() => {
          if (disposed || generation !== refreshGeneration) return;
          observeNodeSizes();
          return graph.layout();
        })
        .then(() => {
          if (disposed || generation !== refreshGeneration) return;
          return graph.draw();
        })
        .then(() => {
          if (disposed || generation !== refreshGeneration) return;
          observeNodeSizes();
          syncHtmlGraph();
          syncReactNodeViewport(container, graph);
          if (cameraGenerationRef.current === refreshCameraGeneration) return focusGraph(refreshCameraGeneration);
        })
        .then(() => {
          if (disposed || generation !== refreshGeneration) return;
          syncHtmlGraph();
          syncReactNodeViewport(container, graph);
          callbacks.current.onZoomChange(graph.getZoom());
        })
        .catch(() => undefined);
    };
    let focusTimer = 0;
    const focusWhenReady = (attempt = 0, expectedCameraGeneration = cameraGenerationRef.current) => {
      if (disposed) return;
      const renderedNodeCount = containerRef.current?.querySelectorAll(".version-node").length || 0;
      if (renderedNodeCount < graphDataRef.current.nodes.length && attempt < 20) {
        focusTimer = window.setTimeout(() => focusWhenReady(attempt + 1, expectedCameraGeneration), 50);
        return;
      }
      observeNodeSizes();
      void focusGraph(expectedCameraGeneration)
        .then(() => {
          if (disposed) return;
          syncHtmlGraph();
          syncReactNodeViewport(container, graph);
          callbacks.current.onZoomChange(graph.getZoom());
        })
        .catch(() => undefined);
    };
    const initialCameraGeneration = cameraGenerationRef.current;
    void graph.render()
      .then(() => {
        if (disposed) return;
        lastGraphContentKeyRef.current = graphContentKey;
        setGraphReady(true);
        focusWhenReady(0, initialCameraGeneration);
      })
      .catch(() => undefined);
    let resizeTimer = 0;
    const resizeObserver = new ResizeObserver(() => {
      const resizeCameraGeneration = ++cameraGenerationRef.current;
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => focusWhenReady(0, resizeCameraGeneration), 240);
    });
    resizeObserver.observe(containerRef.current.parentElement!);
    graphRef.current = graph;
    return () => {
      disposed = true;
      clearTimeout(focusTimer);
      clearTimeout(resizeTimer);
      clearTimeout(layoutTimer);
      cancelAnimationFrame(viewportFrame);
      cancelAnimationFrame(inertiaFrame);
      cancelAnimationFrame(zoomFrame);
      cancelAnimationFrame(transformFrame);
      zoomControllerRef.current = () => undefined;
      centerControllerRef.current = () => undefined;
      refreshControllerRef.current = () => undefined;
      removeSelectionBox();
      resizeObserver.disconnect();
      nodeResizeObserver.disconnect();
      graph.off(GraphEvent.BEFORE_TRANSFORM, onBeforeTransform);
      graph.off(GraphEvent.AFTER_TRANSFORM, onAfterTransform);
      container.removeEventListener("pointerdown", onPointerDown, true);
      container.removeEventListener("pointermove", onPointerMove, true);
      container.removeEventListener("pointerup", onPointerUp, true);
      container.removeEventListener("pointercancel", onPointerCancel, true);
      container.removeEventListener("click", onClick, true);
      container.removeEventListener("contextmenu", onContextMenu, true);
      container.removeEventListener("wheel", onWheel, true);
      graphRef.current = null;
      graph.destroy();
    };
  }, [theme.slug, reduceMotion]);

  useEffect(() => {
    if (!graphReady || lastGraphContentKeyRef.current === graphContentKey) return;
    lastGraphContentKeyRef.current = graphContentKey;
    refreshControllerRef.current();
  }, [graphContentKey, graphReady]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graphReady || !graph || Math.abs(graph.getZoom() - zoom) < 0.005) return;
    zoomControllerRef.current(zoom);
  }, [zoom, graphReady]);

  useEffect(() => {
    if (!graphReady || !recenterSignal || !graphData.nodes.length) return;
    if (handledRecenterRef.current === recenterSignal) return;
    handledRecenterRef.current = recenterSignal;
    centerControllerRef.current(centerVersion);
  }, [recenterSignal, graphReady, centerVersion]);

  useEffect(() => {
    const graph = graphRef.current;
    const container = containerRef.current;
    if (!graphReady || !graph || !container) return;
    const lineage = ancestorsOf(theme.versions, selected);
    const states: Record<string, string[]> = {};
    for (const node of graphData.nodes) {
      const version = node.id === "working" ? null : Number(String(node.id).replace("version-", ""));
      states[String(node.id)] = selected.includes(version as number) ? ["selected"] : selected.length && version != null && !lineage.has(version) ? ["dimmed"] : version != null && lineage.has(version) ? ["lineage"] : [];
    }
    for (const edge of graphData.edges) {
      const data = edge.data as { sourceVersion: number; targetVersion: number | null };
      states[String(edge.id)] = selected.length && data.targetVersion != null && lineage.has(data.sourceVersion) && lineage.has(data.targetVersion) ? ["lineage"] : selected.length ? ["dimmed"] : [];
    }
    graph.setElementState(states, false);
    graph.updateNodeData(graphData.nodes.map((node) => {
      const version = node.id === "working" ? null : Number(String(node.id).replace("version-", ""));
      return {
        id: node.id,
        data: {
          ...node.data,
          selected: version != null && selected.includes(version),
          lineage: version != null && lineage.has(version),
          dimmed: selected.length > 0 && version != null && !lineage.has(version),
        },
      };
    }));
    let cancelled = false;
    void graph.draw().then(() => {
      if (cancelled || graphRef.current !== graph) return;
      syncReactEdges(container, graph, getOverlayEdges(selected));
      syncReactNodeViewport(container, graph);
    });
    return () => { cancelled = true; };
  }, [selected, theme.versions, graphReady]);

  return <div className="graph-stage"><div className={`graph-canvas ${mode}`} ref={containerRef} /></div>;
}

type AssetQueueItem =
  | { id: string; source: "existing"; index: number; url: string; name: string }
  | { id: string; source: "upload"; index: number; file: File; url: string; name: string };

function buildAssetQueue(current: Asset[], files: File[], urls: string[], removed: Set<string>, order: string[]) {
  const items: AssetQueueItem[] = [
    ...current.flatMap((asset, index) => removed.has(`existing:${index}`) ? [] : [{ id: `existing:${index}`, source: "existing" as const, index, url: asset.url, name: asset.name }]),
    ...files.map((file, index) => ({ id: `upload:${index}`, source: "upload" as const, index, file, url: urls[index], name: file.name })),
  ];
  const positions = new Map(order.map((id, index) => [id, index]));
  return items.sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

function SortableAssetItem({
  item,
  active,
  removable,
  reorderable,
  onSelect,
  onRemove,
}: {
  item: AssetQueueItem;
  active: boolean;
  removable: boolean;
  reorderable: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const dragControls = useDragControls();
  return (
    <Reorder.Item
      as="div"
      value={item.id}
      drag={reorderable ? "x" : false}
      dragControls={dragControls}
      dragListener={false}
      dragElastic={0.08}
      layout
      whileDrag={{ scale: 1.035, zIndex: 20, boxShadow: "0 14px 30px rgba(20, 12, 40, .32)" }}
      className={`asset-queue-item ${active ? "active" : ""} ${reorderable ? "" : "static"}`}
    >
      <button
        type="button"
        className="asset-thumb"
        aria-label={`查看并拖动 ${item.name}`}
        onPointerDown={(event) => {
          if (reorderable && event.button === 0) dragControls.start(event);
        }}
        onClick={onSelect}
      >
        <img src={item.url} alt={item.name} draggable={false} />
      </button>
      {removable && (
        <Button
          type="button"
          variant="destructive"
          size="icon-sm"
          className="asset-remove-button"
          aria-label={`删除 ${item.name}`}
          title="删除图片"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </Button>
      )}
    </Reorder.Item>
  );
}

function AssetPicker({
  label,
  files,
  current,
  removed,
  order,
  editableExisting,
  reorderable,
  onFiles,
  onRemoved,
  onOrder,
}: {
  label: string;
  files: File[];
  current: Asset[];
  removed: Set<string>;
  order: string[];
  editableExisting: boolean;
  reorderable: boolean;
  onFiles: (files: File[]) => void;
  onRemoved: (removed: Set<string>) => void;
  onOrder: (order: string[]) => void;
}) {
  const [localPreviews, setLocalPreviews] = useState<string[]>([]);
  const [activeId, setActiveId] = useState("");
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setLocalPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  const queue = buildAssetQueue(current, files, localPreviews, removed, order);
  const active = queue.find((item) => item.id === activeId) || queue[0];
  useEffect(() => {
    if (queue.length && !queue.some((item) => item.id === activeId)) setActiveId(queue[0].id);
    if (!queue.length && activeId) setActiveId("");
  }, [queue.map((item) => item.id).join("|"), activeId]);
  const remove = (item: AssetQueueItem) => {
    if (item.source === "existing") {
      onRemoved(new Set([...removed, item.id]));
      onOrder(queue.filter((entry) => entry.id !== item.id).map((entry) => entry.id));
    }
    else {
      onFiles(files.filter((_, index) => index !== item.index));
      onOrder(queue.filter((entry) => entry.id !== item.id).map((entry) => {
        if (entry.source !== "upload" || entry.index < item.index) return entry.id;
        return `upload:${entry.index - 1}`;
      }));
    }
  };
  const appendFiles = (next: File[]) => {
    onFiles([...files, ...next]);
    onOrder([...queue.map((item) => item.id), ...next.map((_, index) => `upload:${files.length + index}`)]);
  };
  return (
    <div className={`asset-picker ${queue.length ? "has-preview" : "empty"}`}>
      <div className="asset-picker-heading">
        <span>{label}{queue.length > 1 && <small>{queue.length} 张</small>}</span>
        <label className="asset-add-button" title={`添加${label}`} aria-label={`添加${label}`}><input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple onChange={(event) => { appendFiles([...(event.target.files || [])]); event.currentTarget.value = ""; }} /><Plus size={14} /></label>
      </div>
      {active && <div className="asset-main-preview"><img src={active.url} alt={active.name} /></div>}
      {queue.length > 0 && (
        <Reorder.Group as="div" axis="x" values={queue.map((item) => item.id)} onReorder={reorderable ? onOrder : () => undefined} className="asset-queue">
          {queue.map((item) => (
            <SortableAssetItem
              key={item.id}
              item={item}
              active={item.id === active?.id}
              removable={item.source !== "existing" || editableExisting}
              reorderable={reorderable}
              onSelect={() => setActiveId(item.id)}
              onRemove={() => remove(item)}
            />
          ))}
        </Reorder.Group>
      )}
    </div>
  );
}

function EditorDialog({
  theme,
  open,
  version,
  initialParents,
  initialIntent,
  sessionId,
  onClose,
  onSaved,
  onDirtyChange,
  onSavingChange,
  saveBlocked,
  canStartSave,
}: {
  theme: Theme;
  open: boolean;
  version: number | null;
  initialParents: number[];
  initialIntent?: EditorIntent;
  sessionId: number;
  onClose: (force?: boolean) => void;
  onSaved: (theme: Theme) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  saveBlocked: boolean;
  canStartSave: () => boolean;
}) {
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion();
  const [draft, setDraft] = useState<EditorDraft>(emptyDraft);
  const [assetFiles, setAssetFiles] = useState<{ reference: File[]; result: File[] }>({ reference: [], result: [] });
  const [removedAssets, setRemovedAssets] = useState<{ reference: Set<string>; result: Set<string> }>({ reference: new Set(), result: new Set() });
  const [assetOrder, setAssetOrder] = useState<{ reference: string[]; result: string[] }>({ reference: [], result: [] });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const initialDraft = useRef("");
  const initializedEditor = useRef("");
  const editorDialogRef = useRef<HTMLDivElement>(null);
  const activeSessionRef = useRef(sessionId);
  const editorOpenRef = useRef(open);
  const savingRef = useRef(false);
  const draftHistory = useRef<{ past: EditorDraft[]; future: EditorDraft[] }>({ past: [], future: [] });
  activeSessionRef.current = sessionId;
  editorOpenRef.current = open;
  const detailQuery = useQuery({ queryKey: ["version", theme.slug, version], queryFn: () => api.version(theme.slug, version!), enabled: open && version != null });
  const currentAssets = version == null ? theme.assets : detailQuery.data?.assets || { reference: [], result: [] };
  const editorKey = `${sessionId}:${theme.slug}:${version ?? "working"}:${initialIntent || ""}:${initialParents.join(",")}`;
  const updateDraft = (update: EditorDraft | ((current: EditorDraft) => EditorDraft)) => {
    setDraft((current) => {
      const next = typeof update === "function" ? update(current) : update;
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      draftHistory.current.past = [...draftHistory.current.past.slice(-79), current];
      draftHistory.current.future = [];
      return next;
    });
  };
  const undoDraft = () => {
    setDraft((current) => {
      const previous = draftHistory.current.past.pop();
      if (!previous) return current;
      draftHistory.current.future.unshift(current);
      return previous;
    });
  };
  const redoDraft = () => {
    setDraft((current) => {
      const next = draftHistory.current.future.shift();
      if (!next) return current;
      draftHistory.current.past.push(current);
      return next;
    });
  };
  useEffect(() => {
    if (!open) {
      initializedEditor.current = "";
      return;
    }
    if (initializedEditor.current === editorKey) return;
    if (!open || (version != null && !detailQuery.data)) return;
    const source: Theme | VersionDetail = version == null ? theme : detailQuery.data!;
    const nextIntent = initialEditorIntent(version, initialIntent);
    const nextDraft = {
      change_note: version == null || nextIntent === "grow" ? "" : (source as VersionDetail).change_note || "",
      prompt: source.prompt || "",
      negative: source.negative || "",
      notes: source.notes || "",
      model: source.model || "",
      params: source.params || "",
      parents: initialParents.length ? initialParents : version != null ? [version] : theme.working_base != null ? [theme.working_base] : [],
    };
    initializedEditor.current = editorKey;
    initialDraft.current = JSON.stringify(nextDraft);
    setDraft(nextDraft);
    draftHistory.current = { past: [], future: [] };
    setAssetFiles({ reference: [], result: [] });
    setRemovedAssets({ reference: new Set(), result: new Set() });
    const sourceAssets = source.assets || { reference: [], result: [] };
    setAssetOrder({
      reference: sourceAssets.reference.map((_, index) => `existing:${index}`),
      result: sourceAssets.result.map((_, index) => `existing:${index}`),
    });
    setError("");
  }, [open, version, detailQuery.data, initialIntent, editorKey]);
  useEffect(() => {
    const loading = version != null && !detailQuery.data;
    onDirtyChange(open && !loading && (
      JSON.stringify(draft) !== initialDraft.current || assetFiles.reference.length > 0 || assetFiles.result.length > 0
      || removedAssets.reference.size > 0 || removedAssets.result.size > 0
      || assetOrder.reference.join("|") !== (currentAssets.reference || []).map((_, index) => `existing:${index}`).join("|")
      || assetOrder.result.join("|") !== (currentAssets.result || []).map((_, index) => `existing:${index}`).join("|")
    ));
  }, [open, version, detailQuery.data, draft, assetFiles, removedAssets, assetOrder, onDirtyChange]);

  const save = async (targetIntent: EditorIntent = "overwrite") => {
    if (savingRef.current || !canStartSave() || !canSaveEditor(version, targetIntent, draft, theme.can_create_root)) return;
    const requestedSession = sessionId;
    savingRef.current = true;
    onSavingChange(true);
    setSaving(true);
    try {
      let result: Theme;
      const toApiOrder = (kind: "reference" | "result"): AssetOrderEntry[] => {
        const existing = currentAssets[kind];
        const entries: AssetOrderEntry[] = [];
        assetOrder[kind].forEach((id) => {
          if (id.startsWith("upload:")) {
            entries.push({ source: "upload", index: Number(id.slice(7)) });
            return;
          }
          const index = Number(id.slice(9));
          if (index >= 0 && index < existing.length) entries.push({ source: "existing", index });
        });
        return entries;
      };
      const orderedAssets = { reference: toApiOrder("reference"), result: toApiOrder("result") };
      if (targetIntent === "overwrite") {
        if (version != null) {
          result = await api.overwriteVersion(theme.slug, version, draft, assetFiles, orderedAssets);
        } else {
          result = await api.updateTheme(theme.slug, draft);
          if (assetFiles.reference.length) result = await api.uploadAssets(theme.slug, "reference", assetFiles.reference);
          if (assetFiles.result.length) result = await api.uploadAssets(theme.slug, "result", assetFiles.result);
        }
      } else {
        try {
          result = await api.grow(theme.slug, draft, assetFiles, orderedAssets);
        } catch (caught) {
          if (!(caught instanceof Error) || !caught.message.includes("uncommitted changes") || !confirm("当前节点有未保存修改。继续演变会用新节点替换当前内容，是否继续？")) throw caught;
          result = await api.grow(theme.slug, draft, assetFiles, orderedAssets, true);
        }
      }
      if (version != null) await queryClient.invalidateQueries({ queryKey: ["version", theme.slug, version] });
      if (!editorOpenRef.current || activeSessionRef.current !== requestedSession) return;
      onSaved(result);
      onDirtyChange(false);
      onClose(true);
    } catch (caught) {
      if (!editorOpenRef.current || activeSessionRef.current !== requestedSession) return;
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      savingRef.current = false;
      onSavingChange(false);
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !editorDialogRef.current?.contains(event.target)) return;
      if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && !event.altKey && key === "z") {
        event.preventDefault();
        undoDraft();
        return;
      }
      if (event.ctrlKey && !event.altKey && key === "r") {
        event.preventDefault();
        redoDraft();
        return;
      }
      if (event.key !== "Enter" || event.altKey || event.metaKey) return;
      const multiline = event.target instanceof HTMLTextAreaElement;
      if (multiline && !event.ctrlKey) return;
      event.preventDefault();
      void save(event.shiftKey ? "grow" : "overwrite");
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [open, draft, assetFiles, assetOrder, removedAssets, version, theme.can_create_root]);

  return (
    <Dialog.Root modal={false} open={open}>
      <Dialog.Portal>
        <Dialog.Content asChild onPointerDownOutside={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest(".version-node")) event.preventDefault();
        }} onInteractOutside={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest(".version-node")) event.preventDefault();
        }} onEscapeKeyDown={(event) => { event.preventDefault(); onClose(); }}>
        <motion.div ref={editorDialogRef} className={`dialog-content editor-dialog ${version != null && !detailQuery.data ? "loading" : ""}`} initial={reduceMotion ? false : { opacity: 0, x: 28, scale: 0.985 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 34, mass: 0.72 }}>
          <div className="editor-header">
            <Dialog.Title className="sr-only">{version == null ? "节点" : `节点 #${String(version).padStart(4, "0")}`}</Dialog.Title>
            <label className="editor-title-block" htmlFor="node-title">
              <span className="node-title-label">节点标题</span>
              <Input id="node-title" className="node-title-input" value={draft.change_note} placeholder={version == null ? "输入标题" : `自动名称 ${detailQuery.data?.digest.slice(0, 6) || "------"}`} onChange={(event) => updateDraft({ ...draft, change_note: event.target.value })} />
            </label>
            <Dialog.Description className="sr-only">编辑节点内容和图片</Dialog.Description>
            <button className="dialog-close" aria-label="关闭" onClick={() => onClose()}><X size={18} /></button>
          </div>
          <div className="editor-scroll">
            <div className="asset-inputs">
              <AssetPicker label="参考图" files={assetFiles.reference} current={currentAssets.reference} removed={removedAssets.reference} order={assetOrder.reference} editableExisting={version != null} reorderable={version != null} onFiles={(files) => setAssetFiles({ ...assetFiles, reference: files })} onRemoved={(removed) => setRemovedAssets({ ...removedAssets, reference: removed })} onOrder={(order) => setAssetOrder({ ...assetOrder, reference: order })} />
              <AssetPicker label="生成结果" files={assetFiles.result} current={currentAssets.result} removed={removedAssets.result} order={assetOrder.result} editableExisting={version != null} reorderable={version != null} onFiles={(files) => setAssetFiles({ ...assetFiles, result: files })} onRemoved={(removed) => setRemovedAssets({ ...removedAssets, result: removed })} onOrder={(order) => setAssetOrder({ ...assetOrder, result: order })} />
            </div>
            <label>提示词<Textarea className="prompt-textarea" value={draft.prompt} onChange={(event) => updateDraft({ ...draft, prompt: event.target.value })} /></label>
            <label>负面提示词<Textarea className="compact-textarea" value={draft.negative} onChange={(event) => updateDraft({ ...draft, negative: event.target.value })} /></label>
            <label>模型<Input value={draft.model} onChange={(event) => updateDraft({ ...draft, model: event.target.value })} /></label>
            <label>参数<Textarea rows={4} value={draft.params} onChange={(event) => updateDraft({ ...draft, params: event.target.value })} /></label>
            <label>备注<Textarea rows={8} value={draft.notes} onChange={(event) => updateDraft({ ...draft, notes: event.target.value })} /></label>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="editor-footer"><div className="dialog-actions"><Button className="editor-action-button" variant="secondary" onClick={() => onClose()}>取消</Button><Button className="editor-action-button" variant="secondary" disabled={saving || saveBlocked || !canSaveEditor(version, "grow", draft, theme.can_create_root)} onClick={() => void save("grow")}>创建</Button><Button className="editor-action-button" variant="secondary" disabled={saving || saveBlocked || !canSaveEditor(version, "overwrite", draft, theme.can_create_root)} onClick={() => void save("overwrite")}>覆盖</Button></div></div>
        </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Comparator({ comparison, open, onClose }: { comparison: Comparison | null; open: boolean; onClose: () => void }) {
  const leftImage = comparison?.left.assets.result[0]?.url || comparison?.left.assets.reference[0]?.url;
  const rightImage = comparison?.right.assets.result[0]?.url || comparison?.right.assets.reference[0]?.url;
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content compare-dialog">
          <header className="compare-header"><Dialog.Title>节点比较</Dialog.Title><Dialog.Description className="sr-only">并排查看两个节点的成图和提示词差异。</Dialog.Description><Dialog.Close asChild><button className="dialog-close" aria-label="关闭"><X size={18} /></button></Dialog.Close></header>
          {comparison && <>
            <div className="image-compare">
              {[{ detail: comparison.left, image: leftImage }, { detail: comparison.right, image: rightImage }].map(({ detail, image }) => <figure key={detail.version}>{image ? <img src={image} alt="" /> : <div className="compare-empty"><ImageIcon /></div>}<figcaption>#{String(detail.version).padStart(4, "0")} · {detail.change_note}</figcaption></figure>)}
            </div>
            <div className="diff-pane"><Suspense fallback={<div className="diff-loading">DIFF</div>}><ComparatorDiff original={comparison.left.prompt} modified={comparison.right.prompt} /></Suspense></div>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function downloadShareCard(theme: Theme, version: VersionDetail) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f9f9fa";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#18191c";
  context.font = "600 34px Segoe UI";
  context.fillText(theme.title, 56, 72);
  context.font = "500 18px Segoe UI";
  context.fillStyle = "#62676d";
  context.fillText(`#${String(version.version).padStart(4, "0")}  ${version.change_note}`, 56, 108);
  context.fillStyle = "#ffffff";
  context.fillRect(56, 146, 1088, 418);
  context.strokeStyle = "#e5e5e5";
  context.strokeRect(56.5, 146.5, 1087, 417);
  context.fillStyle = "#18191c";
  context.font = "24px Consolas";
  const words = version.prompt.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = `${line} ${word}`.trim();
    if (context.measureText(next).width > 980) { lines.push(line); line = word; } else line = next;
    if (lines.length === 8) break;
  }
  if (line && lines.length < 9) lines.push(line);
  lines.forEach((text, index) => context.fillText(text, 92, 205 + index * 38));
  context.font = "500 17px Consolas";
  context.fillStyle = "#0055ff";
  context.fillText(`${version.model || "MODEL -"}   ${version.params || ""}`, 92, 530);
  const anchor = document.createElement("a");
  anchor.download = `${theme.slug}-${version.version}.png`;
  anchor.href = canvas.toDataURL("image/png");
  anchor.click();
}

type SettingsTab = "theme" | "canvas" | "shortcuts";

const settingsNavigation: { group: string; tabs: { id: SettingsTab; label: string; description: string; icon: typeof FilePlus2 }[] }[] = [
  {
    group: "工作区",
    tabs: [
      { id: "theme", label: "主题", description: "名称、描述与标签", icon: FilePlus2 },
      { id: "canvas", label: "画布", description: "视图与节点显示", icon: Maximize2 },
    ],
  },
  {
    group: "高级",
    tabs: [
      { id: "shortcuts", label: "快捷键", description: "编辑器键盘操作", icon: KeyRound },
    ],
  },
];

const shortcutGroups = [
  {
    title: "节点编辑器",
    items: [
      { label: "覆盖当前节点", description: "保存修改到当前节点", keys: ["Enter"] },
      { label: "创建子节点", description: "从当前内容创建新的演变节点", keys: ["Shift", "Enter"] },
      { label: "撤销编辑", description: "撤销上一次字段修改", keys: ["Ctrl Z"] },
      { label: "重做编辑", description: "恢复上一次撤销的字段修改", keys: ["Ctrl R"] },
    ],
  },
];

function SettingsDialog({
  theme,
  preferences,
  open,
  onClose,
  onSave,
}: {
  theme: Theme;
  preferences: WorkspacePreferences;
  open: boolean;
  onClose: () => void;
  onSave: (theme: Partial<Theme>, preferences: WorkspacePreferences) => Promise<void>;
}) {
  const [themeDraft, setThemeDraft] = useState({ title: theme.title, description: theme.description, tags: theme.tags.join(", ") });
  const [preferenceDraft, setPreferenceDraft] = useState(preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<SettingsTab>("theme");
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (!open) return;
    setThemeDraft({ title: theme.title, description: theme.description, tags: theme.tags.join(", ") });
    setPreferenceDraft(preferences);
    setSearch("");
    setError("");
  }, [open, theme.title, theme.description, theme.tags, preferences]);
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave({
        title: themeDraft.title.trim(),
        description: themeDraft.description.trim(),
        tags: themeDraft.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      }, preferenceDraft);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存设置失败");
    } finally {
      setSaving(false);
    }
  };
  const activeTab = settingsNavigation.flatMap((group) => group.tabs).find((item) => item.id === tab)!;
  const filteredNavigation = settingsNavigation.map((group) => ({
    ...group,
    tabs: group.tabs.filter((item) => `${item.label}${item.description}`.toLowerCase().includes(search.trim().toLowerCase())),
  })).filter((group) => group.tabs.length > 0);
  const filteredTabs = filteredNavigation.flatMap((group) => group.tabs);
  const filteredTabKey = filteredTabs.map((item) => item.id).join("|");
  useEffect(() => {
    if (!search.trim() || !filteredTabs.length || filteredTabs.some((item) => item.id === tab)) return;
    setTab(filteredTabs[0].id);
  }, [search, tab, filteredTabKey]);
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    if (!tabs.length) return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next = tabs[(Math.max(0, current) + direction + tabs.length) % tabs.length];
    next.click();
    next.focus();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content settings-dialog">
          <Dialog.Title className="sr-only">设置</Dialog.Title>
          <Dialog.Description className="sr-only">修改主题信息、画布行为和节点显示。</Dialog.Description>
          <Dialog.Close asChild><button className="dialog-close" aria-label="关闭"><X size={18} /></button></Dialog.Close>
          <div className="settings-layout">
            <nav className="settings-sidebar" aria-label="设置分类">
              <div className="settings-search">
                <Search size={14} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索设置" aria-label="搜索设置" />
              </div>
              <div className="settings-nav" role="tablist" aria-orientation="vertical" onKeyDown={onTabKeyDown}>
                {filteredNavigation.length ? filteredNavigation.map((group) => (
                  <div className="settings-nav-group" key={group.group}>
                    <span className="settings-nav-title">{group.group}</span>
                    {group.tabs.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button key={item.id} id={`settings-tab-${item.id}`} type="button" role="tab" aria-controls={`settings-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
                          <Icon size={15} />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )) : <p className="settings-no-results">没有匹配的设置</p>}
              </div>
              <span className="settings-version">Prompt Vault</span>
            </nav>
            <div className="settings-panel">
              <header className="settings-panel-header">
                <h2>{activeTab.label}</h2>
                <p>{activeTab.description}</p>
              </header>
              <div id={`settings-panel-${tab}`} className="settings-content" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
                {tab === "theme" && (
                  <section className="settings-section">
                    <div className="settings-section-heading"><h3>主题信息</h3><p>这些内容会显示在主题库和工作区标题栏。</p></div>
                    <div className="settings-field-list">
                      <label>名称<Input value={themeDraft.title} onChange={(event) => setThemeDraft({ ...themeDraft, title: event.target.value })} /></label>
                      <label>描述<Textarea rows={4} value={themeDraft.description} onChange={(event) => setThemeDraft({ ...themeDraft, description: event.target.value })} /></label>
                      <label>标签<Input value={themeDraft.tags} onChange={(event) => setThemeDraft({ ...themeDraft, tags: event.target.value })} placeholder="用逗号分隔" /></label>
                    </div>
                  </section>
                )}
                {tab === "canvas" && (
                  <>
                    <section className="settings-section">
                      <div className="settings-section-heading"><h3>视图</h3><p>控制工作区初次打开时的尺寸和位置。</p></div>
                      <div className="settings-field-list">
                        <label className="range-setting"><span>节点宽度 <strong>{preferenceDraft.nodeWidth}px</strong></span><input type="range" min="220" max="360" step="20" value={preferenceDraft.nodeWidth} onChange={(event) => setPreferenceDraft({ ...preferenceDraft, nodeWidth: Number(event.target.value) })} /></label>
                        <label className="range-setting"><span>{preferenceDraft.autoFit ? "自动适配缩放上限" : "打开时缩放"} <strong>{Math.round(preferenceDraft.initialZoom * 100)}%</strong></span><input type="range" min="0.5" max="1.5" step="0.1" value={preferenceDraft.initialZoom} onChange={(event) => setPreferenceDraft({ ...preferenceDraft, initialZoom: Number(event.target.value) })} /></label>
                        <label className="switch-setting"><span><strong>打开时自动适配</strong><small>让全部节点进入可视区域</small></span><input type="checkbox" checked={preferenceDraft.autoFit} onChange={(event) => setPreferenceDraft({ ...preferenceDraft, autoFit: event.target.checked })} /></label>
                      </div>
                    </section>
                    <section className="settings-section">
                      <div className="settings-section-heading"><h3>节点内容</h3><p>调整画布卡片中展示的信息密度。</p></div>
                      <label className="switch-setting"><span><strong>显示提示词摘要</strong><small>关闭后节点只保留名称与模型</small></span><input type="checkbox" checked={preferenceDraft.showPrompt} onChange={(event) => setPreferenceDraft({ ...preferenceDraft, showPrompt: event.target.checked })} /></label>
                    </section>
                  </>
                )}
                {tab === "shortcuts" && shortcutGroups.map((group) => (
                  <section className="settings-section" key={group.title}>
                    <div className="settings-section-heading"><h3>{group.title}</h3><p>在节点编辑器打开时可用。</p></div>
                    <div className="shortcut-list">
                      {group.items.map((item) => (
                        <div className="shortcut-row" key={item.label}>
                          <span><strong>{item.label}</strong><small>{item.description}</small></span>
                          <div>{item.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
              <footer className="settings-footer">{error && <p className="settings-error">{error}</p>}<Button variant="ghost" onClick={onClose}>取消</Button><Button disabled={saving || !themeDraft.title.trim()} onClick={save}>保存设置</Button></footer>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Workspace({ slug, onBack, onUnauthorized, onDirtyChange }: { slug: string; onBack: () => void; onUnauthorized: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const queryClient = useQueryClient();
  const themeQuery = useQuery({ queryKey: ["theme", slug], queryFn: () => api.theme(slug) });
  const theme = themeQuery.data;
  const [selected, setSelected] = useState<number[]>([]);
  const [mode, setMode] = useState<CanvasMode>("pan");
  const [preferences, setPreferences] = useState(() => loadWorkspacePreferences(slug));
  const [zoom, setZoom] = useState(() => loadWorkspacePreferences(slug).initialZoom);
  const [recenterSignal, setRecenterSignal] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mobile = useMobileWorkspace();
  const [editor, setEditor] = useState<EditorSessionState>({ open: false, version: null, parents: [], session: 0 });
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [workingMutation, setWorkingMutation] = useState(false);
  const editorRef = useRef(editor);
  const editorDirtyRef = useRef(editorDirty);
  const editorSavingRef = useRef(editorSaving);
  const workingMutationRef = useRef(workingMutation);
  editorRef.current = editor;
  editorDirtyRef.current = editorDirty;
  editorSavingRef.current = editorSaving;
  workingMutationRef.current = workingMutation;
  const [contextVersion, setContextVersion] = useState<ContextTarget>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState<VersionDetail | null>(null);
  useEffect(() => {
    if (themeQuery.error instanceof ApiError && themeQuery.error.status === 401) onUnauthorized();
  }, [themeQuery.error, onUnauthorized]);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(""), 2500); return () => clearTimeout(id); }, [notice]);
  useEffect(() => onDirtyChange(editorDirty), [editorDirty, onDirtyChange]);
  useEffect(() => {
    const next = loadWorkspacePreferences(slug);
    setPreferences(next);
    setZoom(next.initialZoom);
  }, [slug]);

  const applyTheme = (updated: Theme) => {
    queryClient.setQueryData(["theme", slug], updated);
    queryClient.invalidateQueries({ queryKey: ["themes"] });
  };
  const mark = async (version: number, marks: Record<string, boolean>) => applyTheme(await api.markVersion(slug, version, marks));
  const compareSelected = async (versions = selected) => {
    if (versions.length !== 2) { setNotice("请选择两个节点进行比较"); return; }
    setComparison(await api.compare(slug, versions[0], versions[1]));
  };
  const copyNode = async (version: number) => {
    const detail = await api.version(slug, version);
    setCopied(detail);
    await navigator.clipboard?.writeText(detail.prompt).catch(() => undefined);
    setNotice("节点内容已复制");
  };
  const deleteNode = async (version: number) => {
    if (!confirm(`永久删除节点 #${String(version).padStart(4, "0")}？`)) return;
    try { applyTheme(await api.deleteVersion(slug, version)); setSelected(selected.filter((item) => item !== version)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "删除失败"); }
  };
  const discardWorking = async () => {
    if (editorSavingRef.current) { setNotice("节点正在保存，请稍候"); return; }
    if (workingMutationRef.current) return;
    if (!theme?.dirty || !confirm("丢弃当前未保存节点并恢复到最近版本？")) return;
    workingMutationRef.current = true;
    setWorkingMutation(true);
    try {
      applyTheme(await api.discardWorking(slug));
      setSelected([]);
      closeEditor(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "丢弃未保存节点失败");
    } finally {
      workingMutationRef.current = false;
      setWorkingMutation(false);
    }
  };
  const share = async (version: number) => downloadShareCard(theme!, await api.version(slug, version));
  const contextSummary = typeof contextVersion === "number" ? theme?.versions.find((item) => item.version === contextVersion) : undefined;
  const openEditor = (version: number | null, intent?: EditorIntent, parents = selected) => {
    const activeEditor = editorRef.current;
    if (activeEditor.open && editorDirtyRef.current && !confirm("当前编辑内容尚未保存，是否放弃修改？")) return;
    setEditorDirty(false);
    setEditor((current) => {
      const next = nextEditorState(current, version, intent, parents);
      editorRef.current = next;
      return next;
    });
  };
  const closeEditor = (force = false) => {
    if (!force && editorSavingRef.current) { setNotice("节点正在保存，请稍候"); return; }
    if (!force && editorDirty && !confirm("当前编辑内容尚未保存，是否放弃修改？")) return;
    setEditorDirty(false);
    setEditor((current) => {
      const next = { open: false, version: null, parents: [], session: current.session };
      editorRef.current = next;
      return next;
    });
  };

  if (!theme) return <div className="loading-screen">Prompt Vault</div>;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <main className={`workspace-shell ${editor.open ? "editor-open" : ""}`}>
          <header className="workspace-header">
            <div className="workspace-title"><IconButton label="返回主题库" onClick={onBack}><ArrowLeft size={18} /></IconButton><div><h1>{theme.title}</h1><span>{theme.version_count} 节点{theme.dirty ? " · 有未保存修改" : ""}</span></div></div>
            <div className="workspace-actions">
              <IconButton label={theme.starred ? "取消主题收藏" : "收藏主题"} onClick={async () => applyTheme(await api.toggleThemeStar(slug))}><Star size={18} fill={theme.starred ? "currentColor" : "none"} /></IconButton>
              <IconButton label={theme.archived ? "恢复主题" : "归档主题"} onClick={async () => applyTheme(await api.toggleArchive(slug))}><Archive size={18} /></IconButton>
              <IconButton label="设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></IconButton>
            </div>
          </header>
          <VersionCanvas theme={theme} selected={selected} mode={mobile ? "pan" : mode} preferences={preferences} zoom={zoom} recenterSignal={recenterSignal} centerVersion={editor.open ? editor.version : undefined} onSelected={setSelected} onOpen={(version) => openEditor(version, undefined, version == null ? [] : [version])} onBlank={() => closeEditor()} onContext={setContextVersion} onZoomChange={setZoom} />
          <div className="canvas-toolbar">
            <div className="tool-segment"><IconButton label="平移画布" aria-pressed={mode === "pan"} onClick={() => setMode("pan")}><Hand size={17} /></IconButton><IconButton label="框选节点" aria-pressed={mode === "select"} onClick={() => setMode("select")}><MousePointer2 size={17} /></IconButton></div>
            {selected.length > 0 && <span className="selection-count">{selected.length} 已选</span>}
            <div className="zoom-segment"><IconButton label="缩小" onClick={() => setZoom((value) => Math.max(0.25, value / 1.2))}><ZoomOut size={16} /></IconButton><button className="zoom-readout" onClick={() => setZoom(1)} title="重置为 100%">{Math.round(zoom * 100)}%</button><IconButton label="放大" onClick={() => setZoom((value) => Math.min(3, value * 1.2))}><ZoomIn size={16} /></IconButton></div>
            <IconButton label="回到中心" onClick={() => setRecenterSignal((value) => value + 1)}><LocateFixed size={17} /></IconButton>
            <IconButton label="比较所选节点" disabled={selected.length !== 2} onClick={() => compareSelected()}><GitCompareArrows size={17} /></IconButton>
          </div>
          {notice && <div className="toast">{notice}</div>}
          <EditorDialog theme={theme} open={editor.open} version={editor.version} initialParents={editor.parents} initialIntent={editor.intent} sessionId={editor.session} onClose={closeEditor} onSaved={applyTheme} onDirtyChange={setEditorDirty} onSavingChange={(value) => { editorSavingRef.current = value; setEditorSaving(value); }} saveBlocked={workingMutation} canStartSave={() => !workingMutationRef.current} />
          <SettingsDialog theme={theme} preferences={preferences} open={settingsOpen} onClose={() => setSettingsOpen(false)} onSave={async (themeChanges, nextPreferences) => { const updated = await api.updateTheme(slug, themeChanges); saveWorkspacePreferences(slug, nextPreferences); setPreferences(nextPreferences); setZoom(nextPreferences.initialZoom); applyTheme(updated); }} />
          <Comparator comparison={comparison} open={!!comparison} onClose={() => setComparison(null)} />
        </main>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu">
          <ContextMenu.Item disabled={contextVersion == null} onSelect={() => contextVersion === "working" ? openEditor(null, undefined, []) : contextVersion != null && openEditor(contextVersion, undefined, [contextVersion])}>编辑<span>Enter</span></ContextMenu.Item>
          <ContextMenu.Item disabled={typeof contextVersion !== "number"} onSelect={() => typeof contextVersion === "number" && copyNode(contextVersion)}>复制<span>Ctrl+C</span></ContextMenu.Item>
          <ContextMenu.Item disabled={typeof contextVersion !== "number" || !copied} onSelect={() => { if (typeof contextVersion === "number" && copied) { setSelected([contextVersion]); openEditor(copied.version, "grow", [contextVersion]); } }}>粘贴为子节点<span>Ctrl+V</span></ContextMenu.Item>
          <ContextMenu.Item className="danger" disabled={contextVersion == null || (contextVersion === "working" && (!theme.dirty || editorSaving || workingMutation))} onSelect={() => contextVersion === "working" ? void discardWorking() : typeof contextVersion === "number" && void deleteNode(contextVersion)}><Trash2 size={14} />{contextVersion === "working" ? "丢弃未保存节点" : "删除"}<span>Del</span></ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={typeof contextVersion !== "number"} onSelect={() => typeof contextVersion === "number" && compareSelected(selected.includes(contextVersion) ? selected : [...selected.slice(-1), contextVersion])}><GitCompareArrows size={14} />比较<span>C</span></ContextMenu.Item>
          <ContextMenu.Item disabled={typeof contextVersion !== "number"} onSelect={() => typeof contextVersion === "number" && mark(contextVersion, { favorite: !contextSummary?.favorite })}><Star size={14} />{contextSummary?.favorite ? "取消收藏" : "收藏"}<span>S</span></ContextMenu.Item>
          <ContextMenu.Item disabled={typeof contextVersion !== "number"} onSelect={() => typeof contextVersion === "number" && mark(contextVersion, { featured: !contextSummary?.featured })}><Focus size={14} />{contextSummary?.featured ? "取消代表作" : "标记代表作"}<span>F</span></ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={typeof contextVersion !== "number"} onSelect={() => typeof contextVersion === "number" && share(contextVersion)}><Share2 size={14} />创建分享卡片<span>E</span></ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function TokenDialog({ open, onConnected }: { open: boolean; onConnected: () => void }) {
  const [token, setToken] = useState(getStoredToken());
  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content token-dialog" onEscapeKeyDown={(event) => event.preventDefault()}>
          <KeyRound size={22} />
          <Dialog.Title>连接 Prompt Vault</Dialog.Title>
          <Dialog.Description className="sr-only">输入服务端配置的访问令牌。</Dialog.Description>
          <label>访问令牌<Input type="password" autoFocus value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && token) { setStoredToken(token); onConnected(); } }} /></label>
          <Button disabled={!token} onClick={() => { setStoredToken(token); onConnected(); }}>连接</Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [themeMode, setThemeMode] = useThemeMode();
  const [slug, setSlug] = useState(() => location.hash.startsWith("#/theme/") ? decodeURIComponent(location.hash.slice(8)) : "");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  useEffect(() => {
    const token = getStoredToken();
    if (token) setStoredToken(token);
  }, []);
  useEffect(() => {
    const onHash = () => {
      const nextSlug = location.hash.startsWith("#/theme/") ? decodeURIComponent(location.hash.slice(8)) : "";
      if (workspaceDirty && nextSlug !== slug && !confirm("当前编辑内容尚未保存，是否放弃修改？")) {
        history.replaceState(null, "", slug ? `#/theme/${encodeURIComponent(slug)}` : "#/");
        return;
      }
      setWorkspaceDirty(false);
      setSlug(nextSlug);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [slug, workspaceDirty]);
  useEffect(() => {
    if (!workspaceDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", warnBeforeUnload);
    return () => removeEventListener("beforeunload", warnBeforeUnload);
  }, [workspaceDirty]);
  const openTheme = (next: string) => { location.hash = `#/theme/${encodeURIComponent(next)}`; };
  const back = () => { location.hash = "#/"; };
  return (
    <>
      {slug ? <Workspace slug={slug} onBack={back} onUnauthorized={() => setTokenOpen(true)} onDirtyChange={setWorkspaceDirty} /> : <Library onOpen={openTheme} onUnauthorized={() => setTokenOpen(true)} />}
      <div className="global-controls"><IconButton label={themeMode === "dark" ? "切换浅色" : "切换深色"} onClick={() => setThemeMode(themeMode === "dark" ? "light" : "dark")}>{themeMode === "dark" ? <Sun size={17} /> : <Moon size={17} />}</IconButton></div>
      <TokenDialog open={tokenOpen} onConnected={() => { setTokenOpen(false); queryClient.invalidateQueries(); }} />
    </>
  );
}
