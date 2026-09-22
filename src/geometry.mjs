/**
 * Geometry primitives for box editing (boundbox.box-editing.box-lifecycle).
 * Pure functions, canvas-pixel space, DOM-free.
 */

export const MIN_SIZE = 8;        // minimum committed box size, canvas px
export const DRAG_THRESHOLD = 3;  // movement before a press becomes a drag
export const HANDLE_HIT = 8;      // handle hit radius
export const CLICK_TOLERANCE = 2; // same-point tolerance for overlap cycling

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const pointInRect = (p, r) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Fold negative width/height into a positive rect (resize inversion). */
export function normalizeRect({ x, y, w, h }) {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

/**
 * Clamp a pointer position to the canvas bounds. Used for draw/resize so the
 * anchored edge stays fixed when the pointer crosses a canvas edge — feeding
 * an out-of-bounds pointer into clampRect would TRANSLATE the rect instead
 * (2026-07-16 review finding).
 */
export function snapScalar(value, step) {
  if (!Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

export function snapPoint(point, step) {
  return { x: snapScalar(point.x, step), y: snapScalar(point.y, step) };
}

/** Snap all four edges, then rebuild width/height so alignment stays uniform. */
export function snapRect(rect, step) {
  if (!Number.isFinite(step) || step <= 0) return { ...rect };
  const x = snapScalar(rect.x, step);
  const y = snapScalar(rect.y, step);
  const right = snapScalar(rect.x + rect.w, step);
  const bottom = snapScalar(rect.y + rect.h, step);
  return {
    x,
    y,
    w: Math.max(right - x, Number.EPSILON),
    h: Math.max(bottom - y, Number.EPSILON),
  };
}

export function clampPoint(point, canvas) {
  return {
    x: Math.min(Math.max(point.x, 0), canvas.w),
    y: Math.min(Math.max(point.y, 0), canvas.h),
  };
}

/**
 * Keep a rect fully inside the canvas by translation; enforce a minimum size.
 * Correct for dragging; use clampPoint for draw/resize. `min` may be a number
 * or {w, h} — bound boxes smaller than the default minimum keep their own size
 * as the floor so a pure move never inflates them (review: phantom resize).
 */
export function clampRect(rect, canvas, min = 1) {
  const minW = typeof min === 'number' ? min : min.w;
  const minH = typeof min === 'number' ? min : min.h;
  const w = Math.min(Math.max(rect.w, minW), canvas.w);
  const h = Math.min(Math.max(rect.h, minH), canvas.h);
  const x = Math.min(Math.max(rect.x, 0), canvas.w - w);
  const y = Math.min(Math.max(rect.y, 0), canvas.h - h);
  return { x, y, w, h };
}

export function handlePoints(rect) {
  const { x, y, w, h } = rect;
  return {
    nw: { x, y },
    n: { x: x + w / 2, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 },
    se: { x: x + w, y: y + h },
    s: { x: x + w / 2, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: y + h / 2 },
  };
}

/** Which resize handle (if any) is under the point for this rect. */
export function handleAt(point, rect, hit = HANDLE_HIT) {
  const points = handlePoints(rect);
  for (const handle of HANDLES) {
    const hp = points[handle];
    if (Math.abs(point.x - hp.x) <= hit && Math.abs(point.y - hp.y) <= hit) return handle;
  }
  return null;
}

/** Boxes under a point, topmost first (later in the array renders on top). */
export function boxesAt(boxes, point) {
  return boxes.filter((b) => pointInRect(point, b.rect)).reverse();
}

/** Apply a handle drag delta to a rect (may produce negative w/h; normalize after). */
export function resizeRect(rect, handle, dx, dy) {
  let { x, y, w, h } = rect;
  if (handle.includes('w')) { x += dx; w -= dx; }
  if (handle.includes('e')) { w += dx; }
  if (handle.includes('n')) { y += dy; h -= dy; }
  if (handle.includes('s')) { h += dy; }
  return { x, y, w, h };
}
