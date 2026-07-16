/**
 * Headless box editor (boundbox.box-editing + L2 box-lifecycle/labeling).
 *
 * Pointer state machine, box store, labeling rules, and overlay-only undo
 * (D-011: bounded snapshot stack; source/wireframe state is out of scope).
 * DOM-free by design so the whole interaction contract is unit-testable;
 * the app layer feeds it pointer events in canvas coordinates and renders
 * from getState().
 *
 * Hardened per the 2026-07-16 adversarial review:
 * - Draw/resize clamp the POINTER (anchor edges stay pinned at canvas edges).
 * - Undo snapshots for drag/resize are captured at first mutation, after any
 *   field edit committed by the same pointerdown's blur.
 * - delete/undo/redo are gated while a gesture is active.
 * - Overlap cycling advances on completed clicks only; drags reset it.
 * - No-op edits (unchanged after validation/clamping) push no undo entries.
 */
import {
  MIN_SIZE, DRAG_THRESHOLD, CLICK_TOLERANCE,
  normalizeRect, clampRect, clampPoint, boxesAt, handleAt, resizeRect, distance,
} from './geometry.mjs';
import { buildSketchPayload } from './export.mjs';
import { buildIteratePayload, hasPendingEdits } from './packet.mjs';

const MAX_UNDO = 100;
const MAX_LABEL = 40;
const MOVE_MODES = new Set(['drawing', 'dragging', 'resizing']);

export function createEditor({ canvas = { w: 1024, h: 768 } } = {}) {
  const state = {
    mode: 'sketch', // sketch | iterate
    canvas: { ...canvas },
    boxes: [], // { id, order, label, description, type, text, rect, origin?, binding?, note?, deleted? }
    selectedId: null,
    counter: 0, // never reused, even after deletes (labeling rule)
    context: { description: '', style: '', background: '' },
    wireframe: null, // { version, sourceText, size } — SVG lives in the app layer
    interaction: { mode: 'idle' },
    lastClick: null, // { point, ids } — completed-click overlap cycling
  };
  const undoStack = [];
  const redoStack = [];
  let lastPoint = { x: 0, y: 0 };

  // --- snapshots (D-011) -----------------------------------------------------
  const docSnapshot = () => JSON.parse(JSON.stringify({
    canvas: state.canvas,
    boxes: state.boxes,
    selectedId: state.selectedId,
    counter: state.counter,
    context: state.context,
  }));
  const applySnapshot = (snap) => {
    state.canvas = snap.canvas;
    state.boxes = snap.boxes;
    state.selectedId = snap.selectedId;
    state.counter = snap.counter;
    state.context = snap.context;
    state.interaction = { mode: 'idle' };
  };
  // Undo is overlay-only (D-011): snapshots deliberately exclude state.wireframe
  // — source loads clear both stacks instead (see loadWireframe).
  const pushUndo = (snap) => {
    undoStack.push(snap);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  };

  const selectedBox = () => state.boxes.find((b) => b.id === state.selectedId) ?? null;
  const idle = () => state.interaction.mode === 'idle';
  const validLabel = (raw) => {
    const label = String(raw).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_LABEL);
    return label.length ? label : null;
  };
  const rectsEqual = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  // Sub-8px wireframe elements keep their own size as the clamp floor so a
  // pure move can never inflate them into a phantom resize edit (review fix).
  const minFor = (box) => (box?.origin === 'wireframe-bound'
    ? { w: Math.min(MIN_SIZE, box.binding.rect.w), h: Math.min(MIN_SIZE, box.binding.rect.h) }
    : MIN_SIZE);

  // --- pointer state machine --------------------------------------------------
  const pointerDown = (point) => {
    lastPoint = point;
    if (!idle()) return; // ignore secondary presses mid-gesture

    const selected = selectedBox();
    if (selected) {
      const handle = handleAt(point, selected.rect);
      if (handle) {
        // snapshot/original captured lazily at first mutation (review fix).
        state.interaction = { mode: 'resizing', handle, start: point, original: null, snapshot: null };
        return;
      }
    }

    const hits = boxesAt(state.boxes, point);
    if (hits.length) {
      const ids = hits.map((b) => b.id);
      // Press keeps the already-selected box (so press-drag moves it); a
      // completed CLICK decides fresh-vs-cycle selection in pointerUp.
      if (!ids.includes(state.selectedId)) state.selectedId = ids[0];
      state.interaction = { mode: 'pressing-box', start: point, hitIds: ids, original: null, snapshot: null };
      return;
    }

    state.lastClick = null;
    state.interaction = { mode: 'pressing-empty', start: point };
  };

  const applyMove = (point) => {
    const it = state.interaction;
    switch (it.mode) {
      case 'pressing-empty':
        if (distance(it.start, point) > DRAG_THRESHOLD) {
          state.interaction = { mode: 'drawing', start: it.start, preview: null };
          applyMove(point);
        }
        return;
      case 'pressing-box':
        if (distance(it.start, point) > DRAG_THRESHOLD) {
          const box = selectedBox();
          if (!box) { state.interaction = { mode: 'idle' }; return; }
          // Capture undo baseline NOW — after any field edit that the same
          // pointerdown's blur committed (stale-snapshot review fix).
          state.interaction = {
            mode: 'dragging', start: it.start, hitIds: it.hitIds,
            original: { ...box.rect }, snapshot: docSnapshot(),
          };
          applyMove(point);
        }
        return;
      case 'drawing': {
        const cp = clampPoint(point, state.canvas);
        it.preview = normalizeRect({ x: it.start.x, y: it.start.y, w: cp.x - it.start.x, h: cp.y - it.start.y });
        return;
      }
      case 'dragging': {
        const box = selectedBox();
        if (!box) return;
        const dx = point.x - it.start.x;
        const dy = point.y - it.start.y;
        box.rect = clampRect({ ...it.original, x: it.original.x + dx, y: it.original.y + dy }, state.canvas, minFor(box));
        return;
      }
      case 'resizing': {
        const box = selectedBox();
        if (!box) return;
        if (!it.snapshot) {
          it.snapshot = docSnapshot();
          it.original = { ...box.rect };
        }
        const cp = clampPoint(point, state.canvas);
        const dx = cp.x - clampPoint(it.start, state.canvas).x;
        const dy = cp.y - clampPoint(it.start, state.canvas).y;
        box.rect = clampRect(normalizeRect(resizeRect(it.original, it.handle, dx, dy)), state.canvas, minFor(box));
        return;
      }
      default:
    }
  };

  const pointerMove = (point) => {
    lastPoint = point;
    applyMove(point);
  };

  /** Commit the gesture. Returns an effect hint for the app layer. */
  const pointerUp = (point = lastPoint) => {
    const it = state.interaction;
    if (MOVE_MODES.has(it.mode)) applyMove(point); // movement carried only in the up event counts
    state.interaction = { mode: 'idle' };

    switch (it.mode) {
      case 'pressing-empty':
        state.selectedId = null; // click on empty canvas deselects
        return null;
      case 'pressing-box': {
        // Completed click: same-spot repeat cycles the overlap stack; a fresh
        // click selects the topmost box.
        const ids = it.hitIds;
        if (
          state.lastClick
          && distance(state.lastClick.point, it.start) <= CLICK_TOLERANCE
          && state.lastClick.ids.join() === ids.join()
        ) {
          const index = ids.indexOf(state.selectedId);
          state.selectedId = ids[(index + 1) % ids.length];
        } else {
          state.selectedId = ids[0];
        }
        state.lastClick = { point: it.start, ids };
        return null;
      }
      case 'drawing': {
        state.lastClick = null;
        const rect = it.preview;
        if (!rect || rect.w < MIN_SIZE || rect.h < MIN_SIZE) return null; // below min: cancel
        pushUndo(docSnapshot());
        state.counter += 1;
        const box = {
          id: `b${state.counter}`,
          order: state.boxes.length,
          label: `box-${state.counter}`,
          description: '',
          type: 'obj',
          text: '',
          rect,
        };
        state.boxes.push(box);
        state.selectedId = box.id;
        return 'focus-description'; // draw -> type is one motion (labeling rule)
      }
      case 'dragging':
      case 'resizing': {
        state.lastClick = null; // a drag is not a click (cycling review fix)
        const box = selectedBox();
        const moved = box && it.original && !rectsEqual(box.rect, it.original);
        if (moved) pushUndo(it.snapshot);
        return null;
      }
      default:
        return null;
    }
  };

  /** Escape cancels the in-progress gesture, restoring the pre-interaction rect. */
  const escape = () => {
    const it = state.interaction;
    if ((it.mode === 'dragging' || it.mode === 'resizing') && it.original) {
      const box = selectedBox();
      if (box) box.rect = { ...it.original };
    }
    state.interaction = { mode: 'idle' };
  };

  // --- commands ----------------------------------------------------------------
  const deleteSelection = () => {
    if (!idle()) return false; // gated mid-gesture (review fix)
    const box = selectedBox();
    if (!box) return false;
    pushUndo(docSnapshot());
    if (box.origin === 'wireframe-bound') {
      // Bound boxes are never removed — delete records intent (marked-deleted;
      // Delete again restores). The diff becomes a delete edit in the packet.
      box.deleted = !box.deleted;
      return true;
    }
    state.boxes = state.boxes.filter((b) => b.id !== box.id);
    state.boxes.filter((b) => b.origin !== 'wireframe-bound').forEach((b, i) => { b.order = i; });
    state.selectedId = null;
    state.lastClick = null;
    return true;
  };

  /**
   * Enter iterate mode for an accepted source version (D-005): bound boxes are
   * rebuilt fresh from the bindings, user-drawn boxes and undo history are
   * cleared (source loads are not undoable per D-011), canvas adopts the
   * wireframe size.
   */
  const loadWireframe = ({ bindings, size, sourceText, version }) => {
    // First load from sketch mode PRESERVES user-drawn boxes — they become
    // pending 'add' edits, never silent data loss (review fix). Iterate->iterate
    // reloads still flush everything per D-005 (guarded by the app's confirm).
    const keptUserBoxes = state.mode === 'sketch'
      ? state.boxes.filter((b) => b.origin !== 'wireframe-bound')
      : [];
    state.mode = 'iterate';
    state.wireframe = { version, sourceText, size: { ...size } };
    state.canvas = { ...size };
    state.selectedId = null;
    state.lastClick = null;
    state.interaction = { mode: 'idle' };
    undoStack.length = 0;
    redoStack.length = 0;
    keptUserBoxes.forEach((b) => { b.rect = clampRect(b.rect, state.canvas, MIN_SIZE); });
    state.boxes = keptUserBoxes;
    state.boxes.push(...bindings.map((binding, i) => ({
      id: `wf-${binding.line}-${binding.column}-${i}`,
      order: i,
      label: binding.label || binding.kind,
      description: '',
      type: 'obj',
      text: '',
      note: '',
      deleted: false,
      origin: 'wireframe-bound',
      binding: JSON.parse(JSON.stringify(binding)),
      rect: { ...binding.rect },
    })));
  };

  const clearWireframe = () => {
    state.mode = 'sketch';
    state.wireframe = null;
    state.boxes = state.boxes.filter((b) => b.origin !== 'wireframe-bound');
    state.boxes.forEach((b, i) => { b.order = i; });
    state.selectedId = null;
    state.lastClick = null; // stale overlap-cycling state (review fix)
    undoStack.length = 0;
    redoStack.length = 0;
  };

  const pendingEdits = () => (state.mode === 'iterate' ? hasPendingEdits(state.boxes, state.canvas) : false);

  const setBoxField = (field, value) => {
    const box = selectedBox();
    if (!box) return false;

    // Bound boxes: label/type are read-only derivations of the wireframe
    // element (edit intent goes through the note/annotate path); geometry and
    // note stay editable.
    if (box.origin === 'wireframe-bound' && (field === 'label' || field === 'type' || field === 'text')) return false;
    if (field === 'note') {
      if (box.origin !== 'wireframe-bound') return false;
      const text = String(value);
      if (text === box.note) return true;
      pushUndo(docSnapshot());
      box.note = text;
      return true;
    }

    // Compute the validated new value first; no-op edits push no undo entry.
    let apply;
    if (field === 'label') {
      const label = validLabel(value);
      if (label === null) return false; // revert-on-empty (labeling rule)
      if (label === box.label) return true;
      apply = () => { box.label = label; };
    } else if (field === 'description' || field === 'text') {
      const text = String(value);
      if (text === box[field]) return true;
      apply = () => { box[field] = text; };
    } else if (field === 'type') {
      if (value !== 'obj' && value !== 'text') return false;
      if (value === box.type) return true;
      apply = () => { box.type = value; };
    } else if (['x', 'y', 'w', 'h'].includes(field)) {
      const str = String(value).trim();
      if (!str) return false; // Number('') === 0 trap (review fix)
      const n = Number(str);
      if (!Number.isFinite(n)) return false; // reject non-numeric, keep last valid
      const rect = clampRect({ ...box.rect, [field]: n }, state.canvas, minFor(box));
      if (rectsEqual(rect, box.rect)) return true;
      apply = () => { box.rect = rect; };
    } else {
      return false;
    }

    pushUndo(docSnapshot());
    apply();
    return true;
  };

  const setContextField = (field, value) => {
    if (!['description', 'style', 'background'].includes(field)) return false;
    const text = String(value);
    if (text === state.context[field]) return true;
    pushUndo(docSnapshot());
    state.context[field] = text;
    return true;
  };

  const setCanvasSize = (w, h) => {
    const wStr = String(w).trim();
    const hStr = String(h).trim();
    if (!wStr || !hStr) return false;
    const width = Math.round(Number(wStr));
    const height = Math.round(Number(hStr));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64) return false;
    if (width === state.canvas.w && height === state.canvas.h) return true;
    pushUndo(docSnapshot());
    state.canvas = { w: width, h: height };
    state.boxes.forEach((b) => { b.rect = clampRect(b.rect, state.canvas, MIN_SIZE); });
    return true;
  };

  const undo = () => {
    if (!idle() || !undoStack.length) return false;
    redoStack.push(docSnapshot());
    applySnapshot(undoStack.pop());
    return true;
  };

  const redo = () => {
    if (!idle() || !redoStack.length) return false;
    undoStack.push(docSnapshot());
    applySnapshot(redoStack.pop());
    return true;
  };

  const toPayload = () => {
    if (state.mode === 'iterate') {
      return buildIteratePayload({
        boxes: state.boxes,
        canvas: state.canvas,
        context: state.context,
        sourceText: state.wireframe.sourceText,
        sourceVersion: state.wireframe.version,
      });
    }
    return buildSketchPayload(
      state.boxes.map((b) => ({ order: b.order, label: b.label, description: b.description, type: b.type, text: b.text, rect: b.rect })),
      state.canvas,
      state.context,
    );
  };

  return {
    state,
    pointerDown,
    pointerMove,
    pointerUp,
    escape,
    deleteSelection,
    setBoxField,
    setContextField,
    setCanvasSize,
    undo,
    redo,
    toPayload,
    selectedBox,
    loadWireframe,
    clearWireframe,
    pendingEdits,
  };
}
