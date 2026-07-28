import type { CanvasMode, EditorIntent } from "./types";

type PointerLike = {
  targetType?: string;
  button?: number;
  buttons?: number;
};

type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type PointLike = { x: number; y: number };

type SaveDraft = {
  note: string;
  parentIds: number[];
};

export type EditorSessionState = {
  open: boolean;
  version: number | null;
  intent?: EditorIntent;
  parents: number[];
  session: number;
};

function isSecondaryPointer(event: PointerLike) {
  return event.button === 2 || Boolean((event.buttons || 0) & 2);
}

export function canDragCanvas(event: PointerLike, allowPrimary = true) {
  return isSecondaryPointer(event) || (allowPrimary && event.targetType === "canvas");
}

export function canDragElement(event: PointerLike) {
  return ["node", "combo"].includes(event.targetType || "") && !isSecondaryPointer(event);
}

export function pointerDragAction(mode: CanvasMode, event: PointerLike): "element" | "canvas" | null {
  if (mode === "select" && !isSecondaryPointer(event)) return null;
  if (canDragElement(event)) return "element";
  if (canDragCanvas(event, mode === "pan")) return "canvas";
  return null;
}

export function pointerClickAction(moved: boolean, nodeTarget: boolean): "suppress" | "node" | "blank" {
  if (moved) return "suppress";
  return nodeTarget ? "node" : "blank";
}

export function approachZoom(current: number, target: number, smoothing = 0.24) {
  if (Math.abs(target - current) < 0.0005) return target;
  return current + (target - current) * smoothing;
}

export function wheelZoomTarget(current: number, deltaPixels: number, intensity = 0.0015) {
  return current * Math.exp(-deltaPixels * intensity);
}

export function wheelDeltaPixels(delta: number, deltaMode: number, pageHeight: number) {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * pageHeight;
  return delta;
}

export function rectanglesIntersect(left: RectLike, right: RectLike) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

export function availableViewportCenter(viewport: RectLike, occluder?: RectLike | null): PointLike {
  const overlapsRight = occluder && occluder.left < viewport.right && occluder.right >= viewport.right - 24;
  const availableRight = overlapsRight ? Math.max(viewport.left, occluder.left) : viewport.right;
  return {
    x: (viewport.left + availableRight) / 2,
    y: (viewport.top + viewport.bottom) / 2,
  };
}

export function translationToCenter(current: PointLike, target: PointLike, zoom = 1): [number, number] {
  return [(target.x - current.x) * zoom, (target.y - current.y) * zoom];
}

export function viewportToGraphPoint(viewport: PointLike, position: PointLike, zoom: number): PointLike {
  return { x: (viewport.x - position.x) / zoom, y: (viewport.y - position.y) / zoom };
}

export function graphToViewportPoint(point: PointLike, position: PointLike, zoom: number): PointLike {
  return { x: position.x + point.x * zoom, y: position.y + point.y * zoom };
}

export function initialEditorIntent(_version: number | null, requested?: EditorIntent): EditorIntent {
  return requested || "updateDraft";
}

export function canSaveEditor(_version: number | null, _intent: EditorIntent, _draft: SaveDraft, _canCreateRoot = false) {
  return true;
}

export function editorSaveOperation(version: number | null, intent: EditorIntent): "overwriteRevision" | "updateDraft" | "saveChild" {
  if (intent === "saveRevision") return "saveChild";
  return version == null ? "updateDraft" : "overwriteRevision";
}

export function nextEditorState(current: EditorSessionState, version: number | null, intent?: EditorIntent, parents: number[] = []): EditorSessionState {
  if (current.open && current.version === version && !intent) {
    return { open: false, version: null, parents: [], session: current.session };
  }
  return { open: true, version, intent, parents: [...parents], session: current.session + 1 };
}
