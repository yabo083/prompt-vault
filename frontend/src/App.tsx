import { forwardRef, lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode as ReactNodeContent } from "react";
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
  ChevronLeft,
  ChevronRight,
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
  Monitor,
  Moon,
  MousePointer2,
  Pencil,
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
import { ApiError, api, connectBrowser } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Kbd } from "./components/ui/kbd";
import { Textarea } from "./components/ui/textarea";
import { fitCanvasText } from "./share-card-text";
import { ancestorsOf, graphStructureSignature, toGraphData, type VaultNodeData } from "./graph-data";
import { approachZoom, availableViewportCenter, canSaveEditor, editorSaveOperation, graphToViewportPoint, initialEditorIntent, nextEditorState, pointerClickAction, pointerDragAction, rectanglesIntersect, translationToCenter, viewportToGraphPoint, wheelDeltaPixels, wheelZoomTarget, type EditorSessionState } from "./interaction-state";
import { buildCarouselSlides, carouselAutoplayOptions, loadLibraryPreferences, saveLibraryPreferences, usesCarousel, type CarouselPreferences, type LibraryPreferences } from "./library-preferences";
import { syncReactEdges, syncReactNodePositions, syncReactNodeViewport, type ReactOverlayEdge } from "./react-node-viewport";
import { nextThemeMode, normalizeThemeMode, resolveThemeMode, type ThemeMode } from "./theme-mode";
import { loadWorkspacePreferences, saveWorkspacePreferences, type WorkspacePreferences } from "./workspace-preferences";
import { consumeLaunchNonce, LocalLaunchScreen } from "./LocalLaunchScreen";
import type {
  Asset,
  CanvasMode,
  Comparison,
  EditorDraft,
  EditorIntent,
  Theme,
  ThemeFilter,
  Revision,
} from "./types";

const ComparatorDiff = lazy(() => import("./ComparatorDiff"));

register(ExtensionCategory.NODE, "vault-react", ReactNode);

const emptyDraft: EditorDraft = {
  note: "",
  prompt: "",
  negative: "",
  notes: "",
  model: "",
  params: "",
  parentIds: [],
};

const IconButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton({ label, children, ...props }, ref) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button ref={ref} variant="ghost" size="icon" className="icon-button" aria-label={label} {...props}>{children}</Button>
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={8}>{label}</Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
  );
});

function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>(() => normalizeThemeMode(localStorage.getItem("prompt-vault-theme")));
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const resolvedMode = resolveThemeMode(mode, systemDark);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedMode;
    localStorage.setItem("prompt-vault-theme", mode);
  }, [mode, resolvedMode]);
  return [mode, setMode, resolvedMode] as const;
}

function ThemeModeButton({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const label = mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色";
  const Icon = mode === "system" ? Monitor : mode === "light" ? Sun : Moon;
  return <IconButton label={`主题：${label}，点击切换`} onClick={() => onChange(nextThemeMode(mode))}><Icon size={17} /></IconButton>;
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

function CarouselSettingsFields({ preferences, onChange }: { preferences: CarouselPreferences; onChange: (preferences: CarouselPreferences) => void }) {
  return (
    <div className="settings-field-list">
      <label className="switch-setting"><span><strong>自动播放</strong><small>卡片包含多张图片时自动切换</small></span><input type="checkbox" checked={preferences.autoplay} onChange={(event) => onChange({ ...preferences, autoplay: event.target.checked })} /></label>
      <label className="range-setting"><span>切换间隔 <strong>{(preferences.delayMs / 1000).toFixed(1)} 秒</strong></span><input type="range" min="1000" max="10000" step="200" value={preferences.delayMs} disabled={!preferences.autoplay} onChange={(event) => onChange({ ...preferences, delayMs: Number(event.target.value) })} /></label>
      <label className="switch-setting"><span><strong>悬停时暂停</strong><small>关闭后鼠标划过不干预轮播</small></span><input type="checkbox" checked={preferences.pauseOnHover} disabled={!preferences.autoplay} onChange={(event) => onChange({ ...preferences, pauseOnHover: event.target.checked })} /></label>
      <label className="switch-setting"><span><strong>循环播放</strong><small>关闭后停在最后一张图片</small></span><input type="checkbox" checked={preferences.loop} onChange={(event) => onChange({ ...preferences, loop: event.target.checked })} /></label>
    </div>
  );
}

function EmblaImageCarousel({ urls, label, preferences, className }: { urls: string[]; label: string; preferences: CarouselPreferences; className: string }) {
  const autoplay = useRef(Autoplay(carouselAutoplayOptions(preferences)));
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: preferences.loop, watchDrag: false }, [autoplay.current]);
  return (
    <div className={`${className} embla`} ref={emblaRef} role="region" aria-label={`${label} 成图轮播`} tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowLeft") emblaApi?.scrollPrev(); if (event.key === "ArrowRight") emblaApi?.scrollNext(); }}>
      <div className="embla-container">
        {urls.map((url, index) => (
          <div className="embla-slide" key={`${url}-${index}`}>
            <img src={url} alt={`${label} 图片 ${index + 1}`} loading="lazy" draggable={false} />
          </div>
        ))}
      </div>
      <button type="button" className="carousel-control previous" aria-label="上一张成图" onClick={(event) => { event.stopPropagation(); emblaApi?.scrollPrev(); }}><ChevronLeft size={16} /></button>
      <button type="button" className="carousel-control next" aria-label="下一张成图" onClick={(event) => { event.stopPropagation(); emblaApi?.scrollNext(); }}><ChevronRight size={16} /></button>
    </div>
  );
}

function ImageCarousel({ urls, fallbackUrl, label, preferences, className, empty }: { urls: string[]; fallbackUrl?: string | null; label: string; preferences: CarouselPreferences; className: string; empty: ReactNodeContent }) {
  if (usesCarousel(urls)) return <EmblaImageCarousel urls={urls} label={label} preferences={preferences} className={className} />;
  const staticUrl = urls[0] || fallbackUrl;
  if (!staticUrl) return empty;
  return <div className={className}><img src={staticUrl} alt={`${label} 图片`} loading="lazy" draggable={false} /></div>;
}

function RepresentativeCarousel({ theme, preferences }: { theme: Theme; preferences: LibraryPreferences }) {
  const slides = buildCarouselSlides({
    title: theme.title,
    representatives: theme.representativeRevisions,
    draftResults: theme.draft.assets.result.map((asset) => ({ previewUrl: asset.url, sha256: asset.sha256 })),
  }, preferences.includeDraftAssets);
  return <ImageCarousel urls={slides.map((slide) => slide.previewUrl)} label={theme.title} preferences={preferences} className="theme-art" empty={<div className="theme-art empty-art"><ImageIcon size={24} /><span>PV</span></div>} />;
}

function ThemeCard({ theme, preferences, onOpen }: { theme: Theme; preferences: LibraryPreferences; onOpen: () => void }) {
  const carouselKey = `${preferences.autoplay}:${preferences.delayMs}:${preferences.pauseOnHover}:${preferences.loop}:${preferences.includeDraftAssets}`;
  return (
    <article className="theme-card" onClick={onOpen}>
      <RepresentativeCarousel key={carouselKey} theme={theme} preferences={preferences} />
      <button type="button" className="theme-card-body" aria-label={`打开主题 ${theme.title}`}>
        <div className="theme-card-title"><span>{theme.title}</span>{theme.starred && <Star size={14} fill="currentColor" />}</div>
        <p>{theme.description || theme.draft.prompt || " "}</p>
        <div className="theme-card-meta"><span>{theme.revisionCount} Revisions</span><span>{theme.category}</span></div>
      </button>
    </article>
  );
}

function LibrarySettingsDialog({
  open,
  preferences,
  onClose,
  onChange,
}: {
  open: boolean;
  preferences: LibraryPreferences;
  onClose: () => void;
  onChange: (preferences: LibraryPreferences) => void;
}) {
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (open) setSearch("");
  }, [open]);
  const carouselVisible = "首页卡片轮播".includes(search.trim());
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content settings-dialog">
          <Dialog.Title className="sr-only">首页设置</Dialog.Title>
          <Dialog.Description className="sr-only">控制主题卡片的图片轮播行为。</Dialog.Description>
          <Dialog.Close asChild><button className="dialog-close" aria-label="关闭"><X size={18} /></button></Dialog.Close>
          <div className="settings-layout">
            <nav className="settings-sidebar" aria-label="设置分类">
              <div className="settings-search"><Search size={14} /><Input className="settings-search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索设置" aria-label="搜索设置" /></div>
              <div className="settings-nav" role="tablist" aria-orientation="vertical">
                {carouselVisible ? <div className="settings-nav-group"><span className="settings-nav-title">首页</span><button type="button" role="tab" aria-selected="true" className="active"><ImageIcon size={15} /><span>卡片轮播</span></button></div> : <p className="settings-no-results">没有匹配的设置</p>}
              </div>
              <span className="settings-version">Prompt Vault</span>
            </nav>
            <div className="settings-panel">
              <header className="settings-panel-header"><h2>首页卡片轮播</h2><p>仅当首页主题卡片包含多张成图时启用。</p></header>
              <div className="settings-content" role="tabpanel">
                <section className="settings-section">
                  <div className="settings-section-heading"><h3>首页轮播行为</h3><p>单张成图静态显示；参考图不加入轮播。</p></div>
                  <CarouselSettingsFields preferences={preferences} onChange={(carousel) => onChange({ ...preferences, ...carousel })} />
                </section>
                <section className="settings-section">
                  <div className="settings-section-heading"><h3>图片来源</h3><p>控制首页卡片是否包含当前 Draft 的全部成图。</p></div>
                  <label className="switch-setting"><span><strong>Draft 成图参与轮播</strong><small>把当前 Draft 的结果图加入代表 Revision 成图</small></span><input type="checkbox" checked={preferences.includeDraftAssets} onChange={(event) => onChange({ ...preferences, includeDraftAssets: event.target.checked })} /></label>
                </section>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Library({ onOpen, onUnauthorized, themeMode, onThemeModeChange }: { onOpen: (slug: string) => void; onUnauthorized: () => void; themeMode: ThemeMode; onThemeModeChange: (mode: ThemeMode) => void }) {
  const [filter, setFilter] = useState<ThemeFilter>("active");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSelected, setBatchSelected] = useState<string[]>([]);
  const [batchWorking, setBatchWorking] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [libraryPreferences, setLibraryPreferences] = useState(loadLibraryPreferences);
  const [newTheme, setNewTheme] = useState({ title: "", category: "", prompt: "", description: "" });
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
    if (filter === "favorite") return theme.starred || theme.hasFavoriteRevisions;
    return true;
  });
  const filters: Array<[ThemeFilter, string]> = [["active", "迭代中"], ["archived", "已归档"], ["favorite", "收藏"], ["all", "全部"]];
  const toggleBatchTheme = (slug: string) => setBatchSelected((current) => current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]);
  const deleteBatch = async () => {
    if (!batchSelected.length || !confirm(`将 ${batchSelected.length} 个主题移入回收站？`)) return;
    setBatchWorking(true);
    setBatchError("");
    try {
      const results = await Promise.allSettled(batchSelected.map((slug) => api.deleteTheme(slug)));
      const failed = batchSelected.filter((_, index) => results[index].status === "rejected");
      setBatchSelected(failed);
      await queryClient.invalidateQueries({ queryKey: ["themes"] });
      if (failed.length) setBatchError(`${failed.length} 个主题删除失败，请重试`);
      else setBatchOpen(false);
    } finally {
      setBatchWorking(false);
    }
  };
  const exportAll = async () => {
    const payload = await api.exportVault();
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "prompt-vault-export.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="library-shell">
      <header className="library-header">
        <div className="wordmark"><span>PV</span><strong>Prompt Vault</strong></div>
        <div className="header-actions">
          <label className="search-field"><Search size={16} /><Input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索主题、标签或提示词" /></label>
          <ThemeModeButton mode={themeMode} onChange={onThemeModeChange} />
          <IconButton label="首页设置" onClick={() => setSettingsOpen(true)}><Settings size={16} /></IconButton>
        </div>
      </header>
      <nav className="filter-tabs" aria-label="主题分类">
        {filters.map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
      </nav>
      <section className="theme-grid">
        {themes.map((theme) => <ThemeCard key={theme.slug} theme={theme} preferences={libraryPreferences} onOpen={() => onOpen(theme.slug)} />)}
      </section>
      {!themesQuery.isLoading && !themes.length && <div className="quiet-empty">没有符合当前条件的主题</div>}
      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content create-dialog">
            <header className="dialog-heading"><Dialog.Title>新建主题</Dialog.Title><Dialog.Description>创建一个独立的提示词探索主题，之后可以继续补充图片与版本。</Dialog.Description></header>
            <Dialog.Close asChild><button className="dialog-close" aria-label="关闭"><X size={18} /></button></Dialog.Close>
            <div className="dialog-field-grid"><label>名称<Input autoFocus value={newTheme.title} onChange={(event) => setNewTheme({ ...newTheme, title: event.target.value })} /></label><label>分类<Input value={newTheme.category} onChange={(event) => setNewTheme({ ...newTheme, category: event.target.value })} placeholder="例如：角色设计" /></label></div>
            <label>初始提示词<Textarea className="code-textarea" rows={7} value={newTheme.prompt} onChange={(event) => setNewTheme({ ...newTheme, prompt: event.target.value })} /></label>
            <label>描述<Textarea rows={3} value={newTheme.description} onChange={(event) => setNewTheme({ ...newTheme, description: event.target.value })} /></label>
            <div className="dialog-actions"><Button disabled={!newTheme.title.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>创建</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <LibrarySettingsDialog open={settingsOpen} preferences={libraryPreferences} onClose={() => setSettingsOpen(false)} onChange={(preferences) => { saveLibraryPreferences(preferences); setLibraryPreferences(preferences); }} />
      <div className="library-fab">
        <motion.div className="fab-menu" aria-hidden={!fabOpen} initial={false} animate={fabOpen ? { opacity: 1, y: 0, scale: 1, pointerEvents: "auto" } : { opacity: 0, y: 10, scale: 0.96, pointerEvents: "none" }} transition={{ duration: 0.16 }}>
          <Button variant="secondary" className="fab-action" tabIndex={fabOpen ? 0 : -1} onClick={() => { setFabOpen(false); setCreateOpen(true); }}><FilePlus2 size={16} />新建</Button>
          <Button variant="secondary" className="fab-action" tabIndex={fabOpen ? 0 : -1} onClick={() => { setFabOpen(false); setBatchSelected([]); setBatchError(""); setBatchOpen(true); }}><Menu size={16} />批量管理</Button>
        </motion.div>
        <Button size="icon" className="fab-trigger" aria-label={fabOpen ? "收起操作菜单" : "展开操作菜单"} aria-expanded={fabOpen} onClick={() => setFabOpen((value) => !value)}><motion.span animate={{ rotate: fabOpen ? 45 : 0 }} transition={{ duration: 0.18 }}><Plus size={24} /></motion.span></Button>
      </div>
      <Dialog.Root open={batchOpen} onOpenChange={setBatchOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content batch-dialog">
            <header className="dialog-heading"><Dialog.Title>批量管理</Dialog.Title><Dialog.Description>选择主题后批量移入回收站，或导出当前 Vault 索引。</Dialog.Description></header>
            <Dialog.Close asChild><button className="dialog-close" aria-label="关闭"><X size={18} /></button></Dialog.Close>
            <div className="batch-theme-list">
              {(themesQuery.data || []).map((theme) => <label className="batch-theme-row" key={theme.slug}><input type="checkbox" checked={batchSelected.includes(theme.slug)} onChange={() => toggleBatchTheme(theme.slug)} /><span><strong>{theme.title}</strong><small>{theme.revisionCount} Revisions</small></span></label>)}
            </div>
            {batchError && <p className="batch-error" role="alert">{batchError}</p>}
            <div className="dialog-actions"><Button variant="secondary" onClick={() => void exportAll()}><Download size={15} />导出索引</Button><Button variant="destructive" disabled={!batchSelected.length || batchWorking} onClick={() => void deleteBatch()}><Trash2 size={15} />删除所选</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

function RevisionNodeCard({ data }: { data: VaultNodeData & { selected?: boolean; dimmed?: boolean; lineage?: boolean } }) {
  const className = ["version-node", data.working && "working", data.selected && "selected", data.dimmed && "dimmed", data.lineage && "lineage"].filter(Boolean).join(" ");
  const carouselKey = `${data.previewUrls.join("|")}:${data.carousel.autoplay}:${data.carousel.delayMs}:${data.carousel.pauseOnHover}:${data.carousel.loop}`;
  return (
    <div className={className} data-version={data.version ?? "working"} style={{ "--node-width": `${data.width}px` } as CSSProperties}>
      <div className="node-media"><ImageCarousel key={carouselKey} urls={data.previewUrls} fallbackUrl={data.preview} label={data.title} preferences={data.carousel} className="node-image" empty={<div className="node-image node-image-empty"><ImageIcon size={22} /></div>} /><div className="node-flags">{data.featured && <Focus size={14} />}{data.favorite && <Star size={14} fill="currentColor" />}</div></div>
      <div className="node-body">
        <div className="node-heading"><strong>{data.title}</strong><span>{data.working ? "DRAFT" : `R${String(data.version).padStart(4, "0")}`}</span></div>
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
  const graphContentKey = graphStructureSignature(theme, preferences);
  const graphVisualKey = JSON.stringify(graphData.nodes.map((node) => [node.id, node.data]));
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const reduceMotion = useReducedMotion();
  const [graphReady, setGraphReady] = useState(false);
  const [graphPositioned, setGraphPositioned] = useState(false);
  const graphPositionedRef = useRef(false);
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
    const lineage = ancestorsOf(themeRef.current.revisions, selection);
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
    setGraphPositioned(false);
    graphPositionedRef.current = false;
    const graph = new Graph({
      container: containerRef.current,
      data: graphDataRef.current,
      zoomRange: [0.25, 3],
      animation: false,
      layout: { type: "dagre", rankdir: "TB", nodesep: 56, ranksep: 76, controlPoints: true },
      node: {
        type: "vault-react",
        style: {
          component: (datum: NodeData) => <RevisionNodeCard data={datum.data as VaultNodeData} />,
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
    const revealGraph = () => {
      graphPositionedRef.current = true;
      setGraphPositioned(true);
    };
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
      if (disposed) return false;
      const selector = version === undefined ? ".version-node" : `.version-node[data-version="${version ?? "working"}"]`;
      const current = renderedCenter(Array.from(container.querySelectorAll<HTMLElement>(selector)));
      if (!current) return false;
      const viewport = container.getBoundingClientRect();
      const editor = version === undefined ? null : document.querySelector<HTMLElement>(".editor-dialog")?.getBoundingClientRect();
      const target = availableViewportCenter(viewport, editor);
      const translation = translationToCenter(current, target, graph.getZoom());
      if (Math.hypot(...translation) < 0.5) return true;
      await graph.translateBy(translation, animation);
      return true;
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
      const id = version === "working" ? "working" : version ? `revision-${version}` : "";
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
      if (target?.closest(".carousel-control")) { pointerDragRef.current.pointerId = -1; return; }
      const version = target?.closest<HTMLElement>(".version-node")?.dataset.version;
      const nodeId = version === "working" ? "working" : version ? `revision-${version}` : "";
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
      const version = drag.nodeId === "working" ? null : Number(drag.nodeId.replace("revision-", ""));
      if (version != null && (event.ctrlKey || event.metaKey)) {
        const current = graph.getElementDataByState("node", "selected").map((item) => Number(String(item.id).replace("revision-", ""))).filter(Number.isFinite);
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
      if (target?.closest(".carousel-control")) return;
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
      callbacks.current.onContext(id === "working" ? "working" : Number(id.replace("revision-", "")));
    });
    graph.on(CanvasEvent.CONTEXT_MENU, () => callbacks.current.onContext(null));
    const focusGraph = async (expectedCameraGeneration = cameraGenerationRef.current) => {
      if (disposed || cameraGenerationRef.current !== expectedCameraGeneration) return false;
      graph.resize();
      const currentPreferences = preferencesRef.current;
      if (disposed || cameraGenerationRef.current !== expectedCameraGeneration) return false;
      if (!graphDataRef.current.nodes.length) return true;
      const viewport = container.getBoundingClientRect();
      const origin: [number, number] = [viewport.width / 2, viewport.height / 2];
      if (currentPreferences.autoFit) {
        await graph.fitView({ when: "overflow" });
        if (disposed || cameraGenerationRef.current !== expectedCameraGeneration) return false;
        if (graph.getZoom() > currentPreferences.initialZoom) await graph.zoomTo(currentPreferences.initialZoom, false, origin);
      } else {
        await graph.zoomTo(zoomRef.current, false, origin);
      }
      if (disposed || cameraGenerationRef.current !== expectedCameraGeneration) return false;
      syncReactNodeViewport(container, graph);
      const centered = await centerRenderedCards(undefined, false);
      if (!centered) return false;
      if (disposed || cameraGenerationRef.current !== expectedCameraGeneration) return false;
      zoomTarget = graph.getZoom();
      return true;
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
    const focusWhenReady = (attempt = 0, expectedCameraGeneration = cameraGenerationRef.current, reveal = false) => {
      if (disposed) return;
      const renderedNodeCount = containerRef.current?.querySelectorAll(".version-node").length || 0;
      if (renderedNodeCount < graphDataRef.current.nodes.length) {
        focusTimer = window.setTimeout(() => focusWhenReady(attempt + 1, expectedCameraGeneration, reveal), 50);
        return;
      }
      observeNodeSizes();
      void focusGraph(expectedCameraGeneration)
        .then((positioned) => {
          if (disposed) return;
          if (!positioned) {
            if (reveal) focusTimer = window.setTimeout(() => focusWhenReady(0, cameraGenerationRef.current, true), 0);
            return;
          }
          syncHtmlGraph();
          syncReactNodeViewport(container, graph);
          callbacks.current.onZoomChange(graph.getZoom());
          if (reveal) revealGraph();
        })
        .catch(() => {
          if (!disposed && reveal) focusTimer = window.setTimeout(() => focusWhenReady(0, cameraGenerationRef.current, true), 50);
        });
    };
    const initialCameraGeneration = cameraGenerationRef.current;
    void graph.render()
      .then(() => {
        if (disposed) return;
        lastGraphContentKeyRef.current = graphContentKey;
        setGraphReady(true);
        focusWhenReady(0, initialCameraGeneration, true);
      })
      .catch(() => undefined);
    let resizeTimer = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!graphPositionedRef.current) return;
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
    const lineage = ancestorsOf(theme.revisions, selected);
    const states: Record<string, string[]> = {};
    for (const node of graphData.nodes) {
      const version = node.id === "working" ? null : Number(String(node.id).replace("revision-", ""));
      states[String(node.id)] = selected.includes(version as number) ? ["selected"] : selected.length && version != null && !lineage.has(version) ? ["dimmed"] : version != null && lineage.has(version) ? ["lineage"] : [];
    }
    for (const edge of graphData.edges) {
      const data = edge.data as { sourceVersion: number; targetVersion: number | null };
      states[String(edge.id)] = selected.length && data.targetVersion != null && lineage.has(data.sourceVersion) && lineage.has(data.targetVersion) ? ["lineage"] : selected.length ? ["dimmed"] : [];
    }
    graph.setElementState(states, false);
    graph.updateNodeData(graphData.nodes.map((node) => {
      const version = node.id === "working" ? null : Number(String(node.id).replace("revision-", ""));
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
  }, [selected, graphVisualKey, graphReady]);

  return <div className="graph-stage"><div className={`graph-canvas ${mode} ${graphPositioned ? "positioned" : "positioning"}`} ref={containerRef} /></div>;
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
  const [titleDialogOpen, setTitleDialogOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const initialDraft = useRef("");
  const initializedEditor = useRef("");
  const editorDialogRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleEditButtonRef = useRef<HTMLButtonElement>(null);
  const activeSessionRef = useRef(sessionId);
  const editorOpenRef = useRef(open);
  const savingRef = useRef(false);
  const draftHistory = useRef<{ past: EditorDraft[]; future: EditorDraft[] }>({ past: [], future: [] });
  activeSessionRef.current = sessionId;
  editorOpenRef.current = open;
  const detailQuery = useQuery({ queryKey: ["revision", theme.slug, version], queryFn: () => api.revision(theme.slug, version!), enabled: open && version != null });
  const currentAssets = version == null ? theme.draft.assets : detailQuery.data?.draft.assets || { reference: [], result: [] };
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
    const source = version == null ? theme.draft : detailQuery.data!.draft;
    const nextIntent = initialEditorIntent(version, initialIntent);
    const nextDraft = {
      note: nextIntent === "saveRevision" ? "" : version == null ? theme.workingTitle : theme.revisions.find((revision) => revision.id === version)?.note || detailQuery.data?.note || "",
      prompt: source.prompt || "",
      negative: source.negative || "",
      notes: source.notes || "",
      model: source.model || "",
      params: source.params || "",
      parentIds: initialParents.length ? initialParents : version != null ? [version] : theme.baseRevision != null ? [theme.baseRevision] : [],
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
    setTitleDialogOpen(false);
  }, [open, version, detailQuery.data, initialIntent, editorKey]);
  useEffect(() => {
    if (!titleDialogOpen) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [titleDialogOpen]);
  useEffect(() => {
    const loading = version != null && !detailQuery.data;
    onDirtyChange(open && !loading && (
      JSON.stringify(draft) !== initialDraft.current || assetFiles.reference.length > 0 || assetFiles.result.length > 0
      || removedAssets.reference.size > 0 || removedAssets.result.size > 0
      || assetOrder.reference.join("|") !== (currentAssets.reference || []).map((_, index) => `existing:${index}`).join("|")
      || assetOrder.result.join("|") !== (currentAssets.result || []).map((_, index) => `existing:${index}`).join("|")
    ));
  }, [open, version, detailQuery.data, draft, assetFiles, removedAssets, assetOrder, onDirtyChange]);

  const save = async (targetIntent: EditorIntent = "updateDraft") => {
    if (savingRef.current || !canStartSave() || !canSaveEditor(version, targetIntent, draft, theme.revisionCount === 0)) return;
    const requestedSession = sessionId;
    savingRef.current = true;
    onSavingChange(true);
    setSaving(true);
    try {
      const assets = Object.fromEntries((["reference", "result"] as const).map((kind) => [kind, {
        remove: currentAssets[kind].flatMap((asset, index) => removedAssets[kind].has(`existing:${index}`) ? [asset.name] : []),
        order: assetOrder[kind].map((id) => id.startsWith("existing:")
          ? { source: "existing", index: Number(id.slice(9)) }
          : { source: "upload", index: Number(id.slice(7)) }),
      }]));
      const edit = {
        sourceRevisionId: version ?? undefined,
        force: false,
        nodeTitle: version == null && targetIntent === "updateDraft" ? draft.note : undefined,
        update: { prompt: draft.prompt, negative: draft.negative, notes: draft.notes, model: draft.model, params: draft.params },
        assets,
        saveRevision: targetIntent === "saveRevision" ? { note: draft.note, parentIds: draft.parentIds } : undefined,
      };
      let result: Theme;
      const operation = editorSaveOperation(version, targetIntent);
      if (operation === "overwriteRevision") {
        result = await api.overwriteRevision(theme.slug, version!, {
          note: draft.note,
          update: edit.update,
          assets,
        }, assetFiles);
      } else {
        try {
          result = await api.applyDraftEdit(theme.slug, edit, assetFiles);
        } catch (caught) {
          if (!(caught instanceof Error) || !caught.message.includes("unsaved Draft changes") || !confirm("当前节点有未保存修改。是否丢弃这些修改并继续？")) throw caught;
          result = await api.applyDraftEdit(theme.slug, { ...edit, force: true }, assetFiles);
        }
      }
      if (version != null) await queryClient.invalidateQueries({ queryKey: ["revision", theme.slug, version] });
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
  const titlePlaceholder = version == null ? "节点说明" : `默认 ${detailQuery.data?.digest.slice(0, 6) || "------"}`;
  const editTitle = () => {
    setTitleDraft(draft.note);
    setTitleDialogOpen(true);
  };
  const renameTitle = () => {
    const title = titleDraft.trim();
    if (!title) return;
    updateDraft((current) => ({ ...current, note: title }));
    setTitleDialogOpen(false);
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
      void save(event.shiftKey ? "saveRevision" : "updateDraft");
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [open, draft, assetFiles, assetOrder, removedAssets, version, theme.revisionCount]);

  return (
    <Dialog.Root modal={false} open={open}>
      <Dialog.Portal>
        <Dialog.Content asChild onOpenAutoFocus={(event) => event.preventDefault()} onPointerDownOutside={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest(".version-node")) event.preventDefault();
        }} onInteractOutside={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest(".version-node")) event.preventDefault();
        }} onEscapeKeyDown={(event) => { event.preventDefault(); onClose(); }}>
        <motion.div ref={editorDialogRef} className={`dialog-content editor-dialog ${version != null && !detailQuery.data ? "loading" : ""}`} initial={reduceMotion ? false : { opacity: 0, x: 28, scale: 0.985 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 34, mass: 0.72 }}>
          <div className="editor-header">
            <Dialog.Title className="sr-only">{version == null ? "节点" : `节点 #${String(version).padStart(4, "0")}`}</Dialog.Title>
            <div className="editor-title-block">
              <span className="node-title-label">节点标题</span>
              <div className="node-title-row">
                <strong className="node-title-display">{draft.note.trim() || titlePlaceholder}</strong>
                <IconButton ref={titleEditButtonRef} className="node-title-edit" label="修改节点标题" onClick={editTitle}><Pencil size={15} /></IconButton>
              </div>
            </div>
            <Dialog.Description className="sr-only">编辑节点内容和图片</Dialog.Description>
            <button className="dialog-close" aria-label="关闭" onClick={() => onClose()}><X size={18} /></button>
          </div>
          <div className="editor-scroll">
            <section className="editor-section">
              <div className="asset-inputs">
                <AssetPicker label="参考图" files={assetFiles.reference} current={currentAssets.reference} removed={removedAssets.reference} order={assetOrder.reference} editableExisting reorderable onFiles={(files) => setAssetFiles({ ...assetFiles, reference: files })} onRemoved={(removed) => setRemovedAssets({ ...removedAssets, reference: removed })} onOrder={(order) => setAssetOrder({ ...assetOrder, reference: order })} />
                <AssetPicker label="生成结果" files={assetFiles.result} current={currentAssets.result} removed={removedAssets.result} order={assetOrder.result} editableExisting reorderable onFiles={(files) => setAssetFiles({ ...assetFiles, result: files })} onRemoved={(removed) => setRemovedAssets({ ...removedAssets, result: removed })} onOrder={(order) => setAssetOrder({ ...assetOrder, result: order })} />
              </div>
            </section>
            <section className="editor-section"><label>提示词<Textarea className="prompt-textarea code-textarea" value={draft.prompt} onChange={(event) => updateDraft({ ...draft, prompt: event.target.value })} /></label><label>负面提示词<Textarea className="compact-textarea code-textarea" value={draft.negative} onChange={(event) => updateDraft({ ...draft, negative: event.target.value })} /></label></section>
            <section className="editor-section"><label>模型<Input value={draft.model} onChange={(event) => updateDraft({ ...draft, model: event.target.value })} /></label><label>参数<Textarea className="code-textarea" rows={4} value={draft.params} onChange={(event) => updateDraft({ ...draft, params: event.target.value })} /></label></section>
            <section className="editor-section"><label>备注<Textarea rows={8} value={draft.notes} onChange={(event) => updateDraft({ ...draft, notes: event.target.value })} /></label></section>
          </div>
          {error && <p className="form-error">{error}</p>}
           <div className="editor-footer"><div className="dialog-actions"><Button className="editor-action-button" variant="ghost" disabled={saving || saveBlocked || !canSaveEditor(version, "updateDraft", draft)} onClick={() => void save("updateDraft")}>保存</Button><Button className="editor-action-button" variant="ghost" disabled={saving || saveBlocked || !canSaveEditor(version, "saveRevision", draft)} onClick={() => void save("saveRevision")}>另存</Button><Button className="editor-action-button" variant="ghost" onClick={() => onClose()}>取消</Button></div></div>
        </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
      <Dialog.Root open={titleDialogOpen} onOpenChange={setTitleDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay title-dialog-overlay" />
          <Dialog.Content className="dialog-content title-dialog" onCloseAutoFocus={(event) => { event.preventDefault(); titleEditButtonRef.current?.focus(); }}>
            <Dialog.Title>修改节点标题</Dialog.Title>
            <Dialog.Description>输入新的节点标题。</Dialog.Description>
            <Input ref={titleInputRef} id="node-title" value={titleDraft} placeholder={titlePlaceholder} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.key !== "Enter") return; event.preventDefault(); renameTitle(); }} />
            <div className="dialog-actions"><Button variant="ghost" onClick={() => setTitleDialogOpen(false)}>取消</Button><Button disabled={!titleDraft.trim()} onClick={renameTitle}>确认</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Dialog.Root>
  );
}

function Comparator({ comparison, open, onClose }: { comparison: Comparison | null; open: boolean; onClose: () => void }) {
  const leftImage = comparison?.left.draft.assets.result[0]?.url || comparison?.left.draft.assets.reference[0]?.url;
  const rightImage = comparison?.right.draft.assets.result[0]?.url || comparison?.right.draft.assets.reference[0]?.url;
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content compare-dialog">
          <header className="compare-header"><Dialog.Title>节点比较</Dialog.Title><Dialog.Description className="sr-only">并排查看两个节点的成图和提示词差异。</Dialog.Description><Dialog.Close asChild><button className="dialog-close" aria-label="关闭"><X size={18} /></button></Dialog.Close></header>
          {comparison && <>
            <div className="image-compare">
              {[{ detail: comparison.left, image: leftImage }, { detail: comparison.right, image: rightImage }].map(({ detail, image }) => <figure key={detail.id}>{image ? <img src={image} alt="" /> : <div className="compare-empty"><ImageIcon /></div>}<figcaption>R{String(detail.id).padStart(4, "0")} · {detail.note}</figcaption></figure>)}
            </div>
            <div className="diff-pane"><Suspense fallback={<div className="diff-loading">DIFF</div>}><ComparatorDiff original={comparison.left.draft.prompt} modified={comparison.right.draft.prompt} /></Suspense></div>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function drawWrappedText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  const lines: string[] = [];
  let line = "";
  let consumed = 0;
  for (const character of characters) {
    const next = `${line}${character}`;
    if (context.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = character.trimStart();
    } else {
      line = next;
    }
    consumed += 1;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && consumed < characters.length) {
    while (context.measureText(`${lines[maxLines - 1]}...`).width > maxWidth) lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1);
    lines[maxLines - 1] = `${lines[maxLines - 1]}...`;
  }
  lines.forEach((value, index) => context.fillText(value, x, y + index * lineHeight));
}

function loadShareImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("成图加载失败"));
    image.src = url;
  });
}

async function downloadShareCard(theme: Theme, revision: Revision) {
  const result = revision.draft.assets.result[0];
  if (!result) throw new Error("该节点没有可用于分享的成图");
  const image = await loadShareImage(result.url);
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f5f6f7";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const standardPrompt = fitCanvasText(context, revision.draft.prompt, {
    maxWidth: 460,
    maxHeight: 286,
    maxFontSize: 18,
    minFontSize: 8,
    lineHeightRatio: 1.35,
    fontFamily: "Consolas",
  });
  const compact = !standardPrompt.fits;
  const imagePanelWidth = compact ? 260 : 600;
  const panelX = imagePanelWidth;
  const contentX = panelX + (compact ? 40 : 48);
  const contentWidth = 1200 - contentX - 48;
  const promptBoxY = compact ? 150 : 194;
  const promptBoxHeight = compact ? 400 : 330;
  const promptInset = 22;
  const promptLayout = compact ? fitCanvasText(context, revision.draft.prompt, {
    maxWidth: contentWidth - promptInset * 2,
    maxHeight: promptBoxHeight - promptInset * 2,
    maxFontSize: 13,
    minFontSize: 0.5,
    lineHeightRatio: 1.25,
    fontFamily: "Consolas",
  }) : standardPrompt;

  const imageScale = Math.max(imagePanelWidth / image.naturalWidth, 630 / image.naturalHeight);
  const imageWidth = image.naturalWidth * imageScale;
  const imageHeight = image.naturalHeight * imageScale;
  context.drawImage(image, (imagePanelWidth - imageWidth) / 2, (630 - imageHeight) / 2, imageWidth, imageHeight);

  context.fillStyle = "#ffffff";
  context.fillRect(panelX, 0, 1200 - panelX, 630);
  context.fillStyle = "#18191c";
  context.fillRect(contentX, compact ? 30 : 42, 34, 34);
  context.fillStyle = "#ffffff";
  context.font = "700 14px Segoe UI";
  context.fillText("PV", contentX + 7, compact ? 53 : 65);
  context.fillStyle = "#18191c";
  context.font = "650 16px Segoe UI";
  context.fillText("Prompt Vault", contentX + 46, compact ? 53 : 65);

  context.font = compact ? "650 26px Segoe UI" : "650 31px Segoe UI";
  drawWrappedText(context, `R${String(revision.id).padStart(4, "0")}  ${revision.note}`, contentX, compact ? 105 : 128, contentWidth, 38, 1);
  context.font = "500 17px Segoe UI";
  context.fillStyle = "#62676d";
  drawWrappedText(context, theme.title, contentX, compact ? 135 : 160, contentWidth, 22, 1);

  context.fillStyle = "#f7f7f8";
  context.beginPath();
  context.roundRect(contentX, promptBoxY, contentWidth, promptBoxHeight, 8);
  context.fill();
  context.strokeStyle = "#e5e5e5";
  context.stroke();
  context.fillStyle = "#18191c";
  context.font = `${promptLayout.fontSize}px Consolas`;
  promptLayout.lines.forEach((line, index) => {
    context.fillText(line, contentX + promptInset, promptBoxY + promptInset + promptLayout.fontSize + index * promptLayout.lineHeight);
  });

  context.font = "500 15px Consolas";
  context.fillStyle = "#0055ff";
  drawWrappedText(context, `${revision.draft.model || "MODEL -"}   ${revision.draft.params || ""}`, contentX, 582, contentWidth, 22, 2);
  const anchor = document.createElement("a");
  anchor.download = `${theme.slug}-revision-${revision.id}.png`;
  anchor.href = canvas.toDataURL("image/png");
  anchor.click();
}

type SettingsTab = "theme" | "canvas" | "carousel" | "shortcuts";

const settingsNavigation: { group: string; tabs: { id: SettingsTab; label: string; description: string; icon: typeof FilePlus2 }[] }[] = [
  {
    group: "工作区",
    tabs: [
      { id: "theme", label: "主题", description: "名称、描述与标签", icon: FilePlus2 },
      { id: "canvas", label: "画布", description: "视图与节点显示", icon: Maximize2 },
      { id: "carousel", label: "轮播", description: "节点图片播放行为", icon: ImageIcon },
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
      { label: "保存", description: "覆盖更新当前节点", keys: ["Enter"] },
      { label: "另存", description: "将修改存为当前节点的子节点", keys: ["Shift", "Enter"] },
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
  onThemeChange,
  onPreferencesChange,
}: {
  theme: Theme;
  preferences: WorkspacePreferences;
  open: boolean;
  onClose: () => void;
  onThemeChange: (theme: Partial<Theme>) => Promise<void>;
  onPreferencesChange: (preferences: WorkspacePreferences) => void;
}) {
  const [themeDraft, setThemeDraft] = useState({ title: theme.title, category: theme.category, description: theme.description, tags: theme.tags.join(", ") });
  const [preferenceDraft, setPreferenceDraft] = useState(preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<SettingsTab>("theme");
  const [search, setSearch] = useState("");
  const queuedThemeRef = useRef("");
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSavesRef = useRef(0);
  const hydratingRef = useRef(false);
  const latestThemeDraftRef = useRef(themeDraft);
  const hasUnsyncedThemeRef = useRef(false);
  latestThemeDraftRef.current = themeDraft;
  const themePayload = (draft = themeDraft) => ({
    title: draft.title.trim(),
    category: draft.category.trim(),
    description: draft.description.trim(),
    tags: draft.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
  });
  const queueThemeSave = (draft = latestThemeDraftRef.current) => {
    const payload = themePayload(draft);
    const serialized = JSON.stringify(payload);
    if (!payload.title) return;
    if (serialized === queuedThemeRef.current) {
      if (pendingSavesRef.current === 0) hasUnsyncedThemeRef.current = false;
      return;
    }
    queuedThemeRef.current = serialized;
    pendingSavesRef.current += 1;
    setSaving(true);
    setError("");
    saveQueueRef.current = saveQueueRef.current.catch(() => undefined).then(() => onThemeChange(payload)).then(() => {
      if (queuedThemeRef.current === serialized) {
        hasUnsyncedThemeRef.current = false;
        setError("");
      }
    }).catch((caught) => {
      if (queuedThemeRef.current === serialized) {
        queuedThemeRef.current = "";
        setError(caught instanceof Error ? caught.message : "设置同步失败");
      }
    }).finally(() => {
      pendingSavesRef.current -= 1;
      if (pendingSavesRef.current === 0) setSaving(false);
    });
  };
  const updatePreferences = (next: WorkspacePreferences) => {
    setPreferenceDraft(next);
    onPreferencesChange(next);
  };
  useEffect(() => {
    if (!open) return;
    const serverDraft = { title: theme.title, category: theme.category, description: theme.description, tags: theme.tags.join(", ") };
    const next = pendingSavesRef.current > 0 || hasUnsyncedThemeRef.current ? latestThemeDraftRef.current : serverDraft;
    hydratingRef.current = true;
    setThemeDraft(next);
    latestThemeDraftRef.current = next;
    if (!hasUnsyncedThemeRef.current) queuedThemeRef.current = JSON.stringify(themePayload(next));
    setPreferenceDraft(preferences);
    setSearch("");
    setError("");
  }, [open, theme.slug]);
  useEffect(() => {
    if (!open) return;
    if (hydratingRef.current) { hydratingRef.current = false; return; }
    const timer = window.setTimeout(() => queueThemeSave(themeDraft), 420);
    return () => clearTimeout(timer);
  }, [open, themeDraft]);
  const close = () => {
    queueThemeSave(latestThemeDraftRef.current);
    onClose();
  };
  const updateThemeDraft = (next: typeof themeDraft) => {
    latestThemeDraftRef.current = next;
    hasUnsyncedThemeRef.current = true;
    setThemeDraft(next);
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
    <Dialog.Root open={open} onOpenChange={(value) => !value && close()}>
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
                <Input className="settings-search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索设置" aria-label="搜索设置" />
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
                <div><h2>{activeTab.label}</h2><p>{activeTab.description}</p></div>
                {(saving || error) && <span role={error ? "alert" : "status"} aria-live="polite" className={`settings-sync-state ${error ? "error" : ""}`}>{error || "正在同步..."}</span>}
              </header>
              <div id={`settings-panel-${tab}`} className="settings-content" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
                {tab === "theme" && (
                  <section className="settings-section">
                    <div className="settings-section-heading"><h3>主题信息</h3><p>这些内容会显示在主题库和工作区标题栏。</p></div>
                    <div className="settings-field-list">
                      <div className="dialog-field-grid"><label>名称<Input value={themeDraft.title} onChange={(event) => updateThemeDraft({ ...themeDraft, title: event.target.value })} /></label><label>分类<Input value={themeDraft.category} onChange={(event) => updateThemeDraft({ ...themeDraft, category: event.target.value })} placeholder="例如：角色设计" /></label></div>
                      <label>描述<Textarea rows={4} value={themeDraft.description} onChange={(event) => updateThemeDraft({ ...themeDraft, description: event.target.value })} /></label>
                      <label>标签<Input value={themeDraft.tags} onChange={(event) => updateThemeDraft({ ...themeDraft, tags: event.target.value })} placeholder="用逗号分隔" /></label>
                    </div>
                  </section>
                )}
                {tab === "canvas" && (
                  <>
                    <section className="settings-section">
                      <div className="settings-section-heading"><h3>视图</h3><p>控制工作区初次打开时的尺寸和位置。</p></div>
                      <div className="settings-field-list">
                        <label className="range-setting"><span>节点宽度 <strong>{preferenceDraft.nodeWidth}px</strong></span><input type="range" min="220" max="360" step="20" value={preferenceDraft.nodeWidth} onChange={(event) => updatePreferences({ ...preferenceDraft, nodeWidth: Number(event.target.value) })} /></label>
                        <label className="range-setting"><span>{preferenceDraft.autoFit ? "自动适配缩放上限" : "打开时缩放"} <strong>{Math.round(preferenceDraft.initialZoom * 100)}%</strong></span><input type="range" min="0.5" max="1.5" step="0.1" value={preferenceDraft.initialZoom} onChange={(event) => updatePreferences({ ...preferenceDraft, initialZoom: Number(event.target.value) })} /></label>
                        <label className="switch-setting"><span><strong>打开时自动适配</strong><small>让全部节点进入可视区域</small></span><input type="checkbox" checked={preferenceDraft.autoFit} onChange={(event) => updatePreferences({ ...preferenceDraft, autoFit: event.target.checked })} /></label>
                      </div>
                    </section>
                    <section className="settings-section">
                      <div className="settings-section-heading"><h3>节点内容</h3><p>调整画布卡片中展示的信息密度。</p></div>
                      <label className="switch-setting"><span><strong>显示提示词摘要</strong><small>关闭后节点只保留名称与模型</small></span><input type="checkbox" checked={preferenceDraft.showPrompt} onChange={(event) => updatePreferences({ ...preferenceDraft, showPrompt: event.target.checked })} /></label>
                    </section>
                  </>
                )}
                {tab === "carousel" && (
                  <section className="settings-section">
                    <div className="settings-section-heading"><h3>当前主题节点轮播</h3><p>仅当节点包含多张成图时启用；单张成图静态显示，参考图不加入轮播。</p></div>
                    <CarouselSettingsFields preferences={preferenceDraft.carousel} onChange={(carousel) => updatePreferences({ ...preferenceDraft, carousel })} />
                  </section>
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
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Workspace({ slug, onBack, onUnauthorized, onDirtyChange, themeMode, onThemeModeChange }: { slug: string; onBack: () => void; onUnauthorized: () => void; onDirtyChange: (dirty: boolean) => void; themeMode: ThemeMode; onThemeModeChange: (mode: ThemeMode) => void }) {
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
  const mark = async (version: number, marks: Record<string, boolean>) => applyTheme(await api.markRevision(slug, version, marks));
  const compareSelected = async (versions = selected) => {
    if (versions.length !== 2) { setNotice("请选择两个节点进行比较"); return; }
    setComparison(await api.compare(slug, versions[0], versions[1]));
  };
  const deleteNode = async (version: number) => {
    if (!confirm(`永久删除节点 R${String(version).padStart(4, "0")}？`)) return;
    try { applyTheme(await api.deleteRevision(slug, version)); setSelected(selected.filter((item) => item !== version)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "删除失败"); }
  };
  const discardWorking = async () => {
    if (editorSavingRef.current) { setNotice("节点正在保存，请稍候"); return; }
    if (workingMutationRef.current) return;
    if (!theme?.hasUnsavedChanges || !confirm("丢弃当前未保存节点并恢复到最近节点？")) return;
    workingMutationRef.current = true;
    setWorkingMutation(true);
    try {
      applyTheme(await api.discardDraft(slug));
      setSelected([]);
      closeEditor(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "丢弃未保存节点失败");
    } finally {
      workingMutationRef.current = false;
      setWorkingMutation(false);
    }
  };
  const share = async (version: number) => {
    try {
      await downloadShareCard(theme!, await api.revision(slug, version));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "分享卡片生成失败");
    }
  };
  const contextSummary = typeof contextVersion === "number" ? theme?.revisions.find((item) => item.id === contextVersion) : undefined;
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
            <div className="workspace-title"><IconButton label="返回主题库" onClick={onBack}><ArrowLeft size={18} /></IconButton><div><h1>{theme.title}</h1><span>{theme.revisionCount} 节点{theme.hasUnsavedChanges ? " · 有未保存修改" : ""}</span></div></div>
            <div className="workspace-actions">
              <IconButton className="workspace-secondary-action" label={theme.starred ? "取消主题收藏" : "收藏主题"} onClick={async () => applyTheme(await api.updateDraft(slug, { starred: !theme.starred }))}><Star size={18} fill={theme.starred ? "currentColor" : "none"} /></IconButton>
              <IconButton className="workspace-secondary-action" label={theme.archived ? "恢复主题" : "归档主题"} onClick={async () => applyTheme(await api.updateDraft(slug, { archived: !theme.archived }))}><Archive size={18} /></IconButton>
              <ThemeModeButton mode={themeMode} onChange={onThemeModeChange} />
              <IconButton label="设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></IconButton>
            </div>
          </header>
          <VersionCanvas key={theme.slug} theme={theme} selected={selected} mode={mobile ? "pan" : mode} preferences={preferences} zoom={zoom} recenterSignal={recenterSignal} centerVersion={editor.open ? editor.version : undefined} onSelected={setSelected} onOpen={(version) => openEditor(version, undefined, version == null ? [] : [version])} onBlank={() => closeEditor()} onContext={setContextVersion} onZoomChange={setZoom} />
          <div className="canvas-toolbar">
            <div className="tool-segment"><IconButton label="平移画布" aria-pressed={mode === "pan"} onClick={() => setMode("pan")}><Hand size={17} /></IconButton><IconButton label="框选节点" aria-pressed={mode === "select"} onClick={() => setMode("select")}><MousePointer2 size={17} /></IconButton></div>
            {selected.length > 0 && <span className="selection-count">{selected.length} 已选</span>}
            <div className="zoom-segment"><IconButton label="缩小" onClick={() => setZoom((value) => Math.max(0.25, value / 1.2))}><ZoomOut size={16} /></IconButton><button className="zoom-readout" onClick={() => setZoom(1)} title="重置为 100%">{Math.round(zoom * 100)}%</button><IconButton label="放大" onClick={() => setZoom((value) => Math.min(3, value * 1.2))}><ZoomIn size={16} /></IconButton></div>
            <IconButton label="回到中心" onClick={() => setRecenterSignal((value) => value + 1)}><LocateFixed size={17} /></IconButton>
            <IconButton label="比较所选节点" disabled={selected.length !== 2} onClick={() => compareSelected()}><GitCompareArrows size={17} /></IconButton>
          </div>
          {notice && <div className="toast">{notice}</div>}
          <EditorDialog theme={theme} open={editor.open} version={editor.version} initialParents={editor.parents} initialIntent={editor.intent} sessionId={editor.session} onClose={closeEditor} onSaved={applyTheme} onDirtyChange={setEditorDirty} onSavingChange={(value) => { editorSavingRef.current = value; setEditorSaving(value); }} saveBlocked={workingMutation} canStartSave={() => !workingMutationRef.current} />
          <SettingsDialog theme={theme} preferences={preferences} open={settingsOpen} onClose={() => setSettingsOpen(false)} onThemeChange={async (themeChanges) => applyTheme(await api.updateDraft(slug, themeChanges))} onPreferencesChange={(nextPreferences) => { saveWorkspacePreferences(slug, nextPreferences); setPreferences(nextPreferences); }} />
          <Comparator comparison={comparison} open={!!comparison} onClose={() => setComparison(null)} />
        </main>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu">
          <ContextMenu.Item disabled={contextVersion == null} onSelect={() => contextVersion === "working" ? openEditor(null, undefined, []) : contextVersion != null && openEditor(contextVersion, undefined, [contextVersion])}>编辑</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={typeof contextVersion !== "number"} onSelect={() => typeof contextVersion === "number" && mark(contextVersion, { featured: !contextSummary?.featured })}><Focus size={14} />{contextSummary?.featured ? "取消代表作" : "标记代表作"}</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item disabled={typeof contextVersion !== "number"} onSelect={() => typeof contextVersion === "number" && compareSelected(selected.includes(contextVersion) ? selected : [...selected.slice(-1), contextVersion])}><GitCompareArrows size={14} />比较</ContextMenu.Item>
          <ContextMenu.Item disabled={!contextSummary?.previewUrls.length} onSelect={() => typeof contextVersion === "number" && void share(contextVersion)}><Share2 size={14} />创建分享卡片</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item className="danger" disabled={contextVersion == null || (contextVersion === "working" && (!theme.hasUnsavedChanges || editorSaving || workingMutation))} onSelect={() => contextVersion === "working" ? void discardWorking() : typeof contextVersion === "number" && void deleteNode(contextVersion)}>删除</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function TokenDialog({ open, onConnected }: { open: boolean; onConnected: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const connect = async () => {
    if (!token || connecting) return;
    setConnecting(true);
    setError("");
    try {
      await connectBrowser(token);
      setToken("");
      onConnected();
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "连接失败");
    } finally {
      setConnecting(false);
    }
  };
  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content token-dialog" onEscapeKeyDown={(event) => event.preventDefault()}>
          <KeyRound size={22} />
          <Dialog.Title>连接 Prompt Vault</Dialog.Title>
          <Dialog.Description className="sr-only">输入服务端配置的访问令牌。</Dialog.Description>
          <label>访问令牌<Input type="password" autoFocus value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void connect(); }} /></label>
          {error && <p className="error-text" role="alert">{error}</p>}
          <Button disabled={!token || connecting} onClick={() => void connect()}>{connecting ? "连接中..." : "连接"}</Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [themeMode, setThemeMode] = useThemeMode();
  const [slug, setSlug] = useState(() => location.hash.startsWith("#/theme/") ? decodeURIComponent(location.hash.slice(8)) : "");
  const [launchNonce, setLaunchNonce] = useState(consumeLaunchNonce);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
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
  if (launchNonce) return <LocalLaunchScreen nonce={launchNonce} onContinue={() => setLaunchNonce("")} />;
  return (
    <>
      {slug ? <Workspace slug={slug} onBack={back} onUnauthorized={() => setTokenOpen(true)} onDirtyChange={setWorkspaceDirty} themeMode={themeMode} onThemeModeChange={setThemeMode} /> : <Library onOpen={openTheme} onUnauthorized={() => setTokenOpen(true)} themeMode={themeMode} onThemeModeChange={setThemeMode} />}
      <TokenDialog open={tokenOpen} onConnected={() => { setTokenOpen(false); queryClient.invalidateQueries(); }} />
    </>
  );
}
