import json
from pathlib import Path

import pytest
from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def shell():
    return (ROOT / "templates" / "index.html").read_text(encoding="utf-8")


@pytest.fixture
def app_source():
    return (ROOT / "frontend" / "src" / "App.tsx").read_text(encoding="utf-8")


@pytest.fixture
def graph_source():
    return (ROOT / "frontend" / "src" / "graph-data.ts").read_text(encoding="utf-8")


@pytest.fixture
def css_source():
    return (ROOT / "frontend" / "src" / "styles.css").read_text(encoding="utf-8")


def test_flask_shell_mounts_the_built_react_application(shell):
    soup = BeautifulSoup(shell, "html.parser")
    assert soup.select_one("#root") is not None
    assert "frontend_script" in shell
    assert "frontend_styles" in shell
    assert "Prompt Vault" in shell


def test_g6_dynamic_asset_alias_is_scoped_to_the_build_directory():
    source = (ROOT / "app.py").read_text(encoding="utf-8")
    assert '@app.get("/assets/<path:filename>")' in source
    assert 'url_for("static", filename=f"dist/assets/{filename}")' in source


def test_formal_frontend_uses_the_selected_product_stack():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    dependencies = package["dependencies"]
    assert dependencies["@antv/g6"] == "5.1.1"
    assert "@radix-ui/react-dialog" in dependencies
    assert "@radix-ui/react-context-menu" in dependencies
    assert "@monaco-editor/react" in dependencies
    assert "embla-carousel-react" in dependencies
    assert "@tanstack/react-query" in dependencies
    assert "framer-motion" in dependencies
    assert "class-variance-authority" in dependencies
    assert "tailwindcss" in package["devDependencies"]
    assert "@tailwindcss/vite" in package["devDependencies"]


def test_canvas_is_a_top_down_multi_parent_dag(app_source, graph_source):
    assert 'type: "dagre"' in app_source
    assert 'rankdir: "TB"' in app_source
    assert 'type: "cubic-vertical"' in app_source
    assert "normalizeParents" in graph_source
    assert 'targetPort: `in-${index}`' in graph_source
    assert 'parents: number[]' in (ROOT / "frontend" / "src" / "types.ts").read_text(encoding="utf-8")


def test_canvas_supports_pan_brush_ctrl_multiselect_and_lineage(app_source):
    assert "pointerDragAction" in app_source
    assert "graph.translateElementBy" in app_source
    assert "graph.translateBy" in app_source
    assert 'mode === "select"' in app_source
    assert 'container.addEventListener("pointerup", onPointerUp, true)' in app_source
    assert 'container.addEventListener("click", onClick, true)' in app_source
    assert 'container.addEventListener("wheel", onWheel, { capture: true, passive: false })' in app_source
    assert "wheelZoomTarget(zoomTarget, delta)" in app_source
    assert "viewportToGraphPoint(" in app_source
    assert "graphToViewportPoint(" in app_source
    assert "rectanglesIntersect(selection, node.getBoundingClientRect())" in app_source
    assert 'drag.selectionBox.className = "canvas-selection-box"' in app_source
    assert "syncReactEdges" in app_source
    assert 'stroke: "transparent"' in app_source
    assert 'modeRef.current === "select" && drag.button === 0' in app_source
    assert "pointerClickAction(pointerDragRef.current.moved" in app_source
    assert "callbacks.current.onOpen(version)" in app_source
    assert "callbacks.current.onBlank()" in app_source
    assert 'target?.closest(".version-node")' in app_source
    assert "event.ctrlKey" in app_source
    assert "ancestorsOf" in app_source
    assert 'states[String(edge.id)]' in app_source
    assert 'graph.on(CanvasEvent.CONTEXT_MENU' in app_source


def test_editor_supports_overwrite_and_multi_source_growth(app_source):
    assert 'EditorIntent' in app_source
    assert 'targetIntent === "overwrite"' in app_source
    assert "overwriteVersion" in app_source
    assert "parents: initialParents.length" in app_source
    assert "api.grow" in app_source
    assert "api.uploadAssets" in app_source
    assert "AssetPicker" in app_source
    assert "removedAssets" in app_source
    assert "assetOrder" in app_source
    assert 'openEditor(copied.version, "grow", [contextVersion])' in app_source


def test_editor_is_a_non_blocking_responsive_drawer(app_source, css_source):
    assert '<Dialog.Root modal={false} open={open}>' in app_source
    assert 'workspace-shell ${editor.open ? "editor-open" : ""}' in app_source
    assert '.workspace-shell.editor-open .graph-stage' not in css_source
    assert 'from "framer-motion"' in app_source
    assert 'transition={reduceMotion ? { duration: 0 }' in app_source
    assert 'role="switch"' not in app_source
    assert "直接修改当前节点" not in app_source
    assert "基于 #" not in app_source
    assert "演变" in app_source
    assert "生长" not in app_source
    assert "parent-strip" not in app_source
    assert '@keyframes drawer-up' not in css_source
    assert "transform: none; animation: none" in css_source
    assert '--panel-shift-x' not in css_source
    assert '--focus-x' not in css_source
    assert 'graph.fitView({ when: "overflow" })' in app_source
    assert "centerRenderedCards(undefined, false)" in app_source
    assert "syncReactNodeViewport" in app_source
    assert "syncReactNodePositions" in app_source
    assert "void graph.draw().then(() =>" in app_source
    assert 'className="editor-scroll"' in app_source
    assert ".editor-scroll::-webkit-scrollbar" in css_source
    assert ".prompt-textarea { min-height: 310px" in css_source
    assert 'className="node-title-input"' in app_source
    assert "editorRef.current = next" in app_source
    assert "nextEditorState(current, version, intent, parents)" in app_source
    assert 'target?.closest(".version-node")' in app_source
    assert 'onBlank={() => closeEditor()}' in app_source
    assert '<span className="node-title-label">节点标题</span>' in app_source
    assert 'className="search-input"' in app_source
    assert 'className="shortcut-strip"' not in app_source
    assert "Ctrl Z" in app_source and "Ctrl R" in app_source
    assert '>取消</Button>' in app_source
    assert '>创建</Button>' in app_source
    assert '>覆盖</Button>' in app_source
    assert app_source.count('className="editor-action-button" variant="secondary"') == 3
    assert 'event.shiftKey ? "grow" : "overwrite"' in app_source
    assert "editorDialogRef.current?.contains(event.target)" in app_source
    assert "savingRef.current" in app_source
    assert "activeSessionRef.current !== requestedSession" in app_source
    assert "canStartSave()" in app_source
    assert "workingMutationRef.current" in app_source
    assert "编辑工作稿" not in app_source
    assert "工作稿" not in app_source


def test_workspace_settings_and_live_zoom_controls_are_wired(app_source, css_source):
    assert "loadWorkspacePreferences" in app_source
    assert "saveWorkspacePreferences" in app_source
    assert '<Settings size={18}' in app_source
    assert "callbacks.current.onZoomChange(graph.getZoom())" in app_source
    assert "const [graphReady, setGraphReady]" in app_source
    assert "if (!graphReady || !graph || !container" in app_source
    assert "if (disposed) return" in app_source
    assert "approachZoom" in app_source
    assert "trackHtmlViewport" in app_source
    assert "requestAnimationFrame" in app_source
    assert 'duration: 420' in app_source
    assert "Math.round(zoom * 100)" in app_source
    assert 'className="zoom-readout"' in app_source
    assert ".zoom-readout" in css_source
    assert 'label="回到中心"' in app_source
    assert "availableViewportCenter(viewport, editor)" in app_source
    assert "translationToCenter(current, target, graph.getZoom())" in app_source
    assert "travelled >= 120" in app_source
    assert "drag.vx = drag.vx * 0.45" in app_source
    assert ".react-edge-layer" in css_source
    assert ".react-edge.lineage" in css_source


def test_images_keep_their_aspect_ratio_and_nodes_measure_their_height(app_source, css_source):
    assert "new ResizeObserver" in app_source
    assert "node.offsetHeight" in app_source
    assert "graph.updateNodeData(updates)" in app_source
    assert ".node-image img { display: block; width: 100%; height: auto; object-fit: contain" in css_source
    assert ".asset-main-preview img { width: 100%; height: auto" in css_source
    assert "buildAssetQueue" in app_source
    assert "asset-queue-item" in app_source
    assert '<Reorder.Group as="div" axis="x"' in app_source
    assert "useDragControls" in app_source
    assert "dragListener={false}" in app_source
    assert "dragControls.start(event)" in app_source
    assert "reorderable={version != null}" in app_source
    assert 'className="asset-remove-button"' in app_source
    assert '<Trash2 size={13}' in app_source
    assert 'label="前移"' not in app_source
    assert 'label="后移"' not in app_source
    assert "multiple" in app_source
    assert ".asset-add-button {" in css_source
    assert "width: 28px; height: 28px" in css_source
    assert "asset-empty-upload" not in app_source


def test_settings_use_split_navigation_and_include_shortcuts(app_source, css_source):
    assert 'type SettingsTab = "theme" | "canvas" | "shortcuts"' in app_source
    assert 'className="settings-sidebar"' in app_source
    assert 'className="settings-content"' in app_source
    assert 'role="tablist"' in app_source
    assert 'role="tabpanel"' in app_source
    assert 'aria-controls={`settings-panel-${item.id}`}' in app_source
    assert 'aria-labelledby={`settings-tab-${tab}`}' in app_source
    assert "快捷键" in app_source
    assert 'className="shortcut-row"' in app_source
    assert ".settings-layout" in css_source
    assert ".settings-sidebar" in css_source
    assert "const updated = await api.updateTheme(slug, themeChanges); saveWorkspacePreferences" in app_source
    assert 'preferenceDraft.autoFit ? "自动适配缩放上限" : "打开时缩放"' in app_source


def test_working_node_can_be_discarded_from_the_context_menu(app_source):
    api_source = (ROOT / "frontend" / "src" / "api.ts").read_text(encoding="utf-8")
    assert 'type ContextTarget = number | "working" | null' in app_source
    assert "丢弃未保存节点" in app_source
    assert "api.discardWorking(slug)" in app_source
    assert 'discardWorking: (slug: string)' in api_source


def test_form_controls_and_scrollbars_use_the_product_style(css_source):
    assert '@import "tailwindcss"' in css_source
    assert "--color-primary: hsl(var(--primary))" in css_source
    assert "--primary: 254 80% 68%" in css_source
    assert "--background: 0 0% 13%" in css_source
    assert "input:not([data-slot]):focus-visible" in css_source
    assert "input[data-slot], textarea[data-slot] { appearance: none; }" in css_source
    assert "scrollbar-color: transparent transparent" in css_source
    assert "textarea::-webkit-scrollbar" in css_source
    assert ".editor-scroll::-webkit-scrollbar-thumb" in css_source
    assert (ROOT / "frontend" / "src" / "components" / "ui" / "input.tsx").exists()
    assert (ROOT / "frontend" / "src" / "components" / "ui" / "textarea.tsx").exists()
    assert (ROOT / "frontend" / "src" / "components" / "ui" / "button.tsx").exists()


def test_context_menu_has_the_three_required_action_groups(app_source):
    assert "粘贴为子节点" in app_source
    assert "标记代表作" in app_source
    assert "创建分享卡片" in app_source
    assert app_source.count("<ContextMenu.Separator") == 2


def test_comparator_is_image_first_with_monaco_diff(app_source, css_source):
    diff_source = (ROOT / "frontend" / "src" / "ComparatorDiff.tsx").read_text(encoding="utf-8")
    assert "<DiffEditor" in diff_source
    assert 'lazy(() => import("./ComparatorDiff"))' in app_source
    assert "image-compare" in app_source
    assert ".image-compare" in css_source
    assert "height: 52%" in css_source


def test_library_categories_and_representative_carousel_are_present(app_source):
    for label in ("迭代中", "已归档", "收藏", "全部"):
        assert label in app_source
    assert "useEmblaCarousel" in app_source
    assert "representative_versions" in app_source


def test_precision_lightbox_tokens_and_mobile_degradation(css_source):
    assert "--background: 0 0% 98%" in css_source
    assert "--background: 0 0% 13%" in css_source
    assert "background-size: 24px 24px" in css_source
    assert "width: var(--node-width, 260px)" in css_source
    assert "border-radius: 4px" in css_source
    assert "object-fit: contain" in css_source
    assert "@media (hover: none) and (pointer: coarse)" in css_source
    assert "grid-template-columns: 1fr" in css_source
    app_source = (ROOT / "frontend" / "src" / "App.tsx").read_text(encoding="utf-8")
    assert "mode={mobile ? \"pan\" : mode}" in app_source


def test_html_nodes_receive_events_without_leaving_graph_coordinates(css_source):
    assert ".version-node {" in css_source
    assert "pointer-events: auto" in css_source
    selected_rule = css_source.split(".version-node.selected {", 1)[1].split("}", 1)[0]
    assert "transform:" not in selected_rule


def test_old_git_and_mode_controls_are_not_user_facing(app_source):
    for removed in ("基础模式", "高级模式", "HEAD", "从此新建分支"):
        assert removed not in app_source


def test_token_is_mirrored_to_a_same_site_cookie_for_media_requests():
    source = (ROOT / "frontend" / "src" / "api.ts").read_text(encoding="utf-8")
    assert "prompt_vault_token=" in source
    assert "SameSite=Strict" in source
