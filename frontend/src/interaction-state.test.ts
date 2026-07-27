import { describe, expect, it } from "vitest";
import {
  canDragCanvas,
  canDragElement,
  canSaveEditor,
  approachZoom,
  availableViewportCenter,
  initialEditorIntent,
  graphToViewportPoint,
  nextEditorState,
  pointerClickAction,
  pointerDragAction,
  rectanglesIntersect,
  translationToCenter,
  viewportToGraphPoint,
  wheelDeltaPixels,
  wheelZoomTarget,
} from "./interaction-state";

describe("canvas pointer behavior", () => {
  it("moves nodes with the primary button and pans from nodes with the secondary button", () => {
    expect(canDragElement({ targetType: "node", button: 0, buttons: 1 })).toBe(true);
    expect(canDragCanvas({ targetType: "node", button: 0, buttons: 1 })).toBe(false);
    expect(canDragElement({ targetType: "node", button: 2, buttons: 2 })).toBe(false);
    expect(canDragCanvas({ targetType: "node", button: 2, buttons: 2 })).toBe(true);
  });

  it("pans from blank canvas with either mouse button", () => {
    expect(canDragCanvas({ targetType: "canvas", button: 0, buttons: 1 })).toBe(true);
    expect(canDragCanvas({ targetType: "canvas", button: 2, buttons: 2 })).toBe(true);
  });

  it("reserves primary-button canvas drags for brushing in select mode", () => {
    expect(canDragCanvas({ targetType: "canvas", button: 0, buttons: 1 }, false)).toBe(false);
    expect(canDragCanvas({ targetType: "node", button: 2, buttons: 2 }, false)).toBe(true);
    expect(pointerDragAction("select", { targetType: "canvas", button: 0, buttons: 1 })).toBeNull();
    expect(pointerDragAction("select", { targetType: "node", button: 0, buttons: 1 })).toBeNull();
    expect(pointerDragAction("select", { targetType: "node", button: 2, buttons: 2 })).toBe("canvas");
  });

  it("selects a card when the marquee touches any part of its visible rectangle", () => {
    const card = { left: 100, top: 100, right: 360, bottom: 480 };
    expect(rectanglesIntersect({ left: 359, top: 220, right: 370, bottom: 240 }, card)).toBe(true);
    expect(rectanglesIntersect({ left: 360, top: 220, right: 370, bottom: 240 }, card)).toBe(false);
    expect(rectanglesIntersect({ left: 361, top: 220, right: 370, bottom: 240 }, card)).toBe(false);
  });

  it("maps every wheel delta to a continuous exponential zoom target", () => {
    expect(wheelZoomTarget(1, 0.5)).toBeLessThan(1);
    expect(wheelZoomTarget(1, 100)).toBeLessThan(wheelZoomTarget(1, 1));
    expect(wheelZoomTarget(wheelZoomTarget(1, 80), -80)).toBeCloseTo(1, 8);
    expect(wheelDeltaPixels(4, 1, 900)).toBe(64);
    expect(wheelDeltaPixels(2, 2, 900)).toBe(1800);
  });

  it("round-trips a pointer anchor through the HTML graph transform", () => {
    const origin = { x: 996.8, y: 198.48 };
    const graphPoint = viewportToGraphPoint(origin, { x: 804.8, y: -152.8 }, 0.8);
    expect(graphPoint.x).toBeCloseTo(240);
    expect(graphPoint.y).toBeCloseTo(439.1);
    const restored = graphToViewportPoint(graphPoint, { x: 804.8, y: -152.8 }, 0.8);
    expect(restored.x).toBeCloseTo(origin.x);
    expect(restored.y).toBeCloseTo(origin.y);
  });

  it("centers against the unobscured canvas and preserves the current zoom", () => {
    const viewport = { left: 0, top: 64, right: 1200, bottom: 800 };
    const editor = { left: 800, top: 76, right: 1188, bottom: 788 };
    const center = availableViewportCenter(viewport, editor);
    expect(center).toEqual({ x: 400, y: 432 });
    const translation = translationToCenter({ x: 610, y: 500 }, center, 0.7);
    expect(translation[0]).toBeCloseTo(-147);
    expect(translation[1]).toBeCloseTo(-47.6);
  });

  it("suppresses the click emitted after pan, node drag, or brush movement", () => {
    expect(pointerClickAction(true, false)).toBe("suppress");
    expect(pointerClickAction(true, true)).toBe("suppress");
    expect(pointerClickAction(false, true)).toBe("node");
    expect(pointerClickAction(false, false)).toBe("blank");
  });

  it("approaches toolbar zoom targets over multiple frames", () => {
    const target = 1.2;
    const firstFrame = approachZoom(1, target);
    expect(firstFrame).toBeGreaterThan(1);
    expect(firstFrame).toBeLessThan(target);
    expect(approachZoom(target - 0.0001, target)).toBe(target);
  });
});

describe("working-root editor state", () => {
  it("opens the working tree in overwrite mode", () => {
    expect(initialEditorIntent(null)).toBe("overwrite");
    expect(initialEditorIntent(3)).toBe("overwrite");
    expect(initialEditorIntent(null, "grow")).toBe("grow");
  });

  it("allows saving a working root and publishing its first node", () => {
    expect(canSaveEditor(null, "overwrite", { change_note: "", parents: [] })).toBe(true);
    expect(canSaveEditor(null, "grow", { change_note: "Root", parents: [] }, true)).toBe(true);
    expect(canSaveEditor(null, "grow", { change_note: "", parents: [] }, true)).toBe(true);
    expect(canSaveEditor(null, "grow", { change_note: "Not another root", parents: [] }, false)).toBe(false);
    expect(canSaveEditor(3, "grow", { change_note: "", parents: [] })).toBe(false);
  });
});

describe("node editor toggle", () => {
  const closed = { open: false, version: null, parents: [], session: 0 };

  it("opens on the first click and closes on the second click of the same node", () => {
    const opened = nextEditorState(closed, 3, undefined, [3]);
    expect(opened).toEqual({ open: true, version: 3, intent: undefined, parents: [3], session: 1 });
    expect(nextEditorState(opened, 3, undefined, [3])).toEqual({ open: false, version: null, parents: [], session: 1 });
  });

  it("switches directly to a different node and keeps explicit grow actions open", () => {
    const opened = nextEditorState(closed, 3, undefined, [3]);
    expect(nextEditorState(opened, 4, undefined, [4])).toMatchObject({ open: true, version: 4, parents: [4], session: 2 });
    expect(nextEditorState(opened, 3, "grow", [3])).toMatchObject({ open: true, version: 3, intent: "grow", session: 2 });
  });
});
