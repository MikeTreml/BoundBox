/**
 * BoundBox app layer: DOM wiring over the headless editor.
 * Bundled into app/boundbox.html by scripts/build-app.mjs (single-file, D-006).
 *
 * Sketch mode: draw labeled boxes on a blank canvas -> boxes.json.
 * Iterate mode: a Wireloom wireframe renders as the background; every bindable
 * element becomes a bound overlay box; moves/deletes/notes diff into
 * packet.json edits (D-005/D-014).
 */
import { createEditor } from './editor.mjs';
import { handleAt, handlePoints, boxesAt } from './geometry.mjs';
import { loadWireframe } from './wireframe.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const editor = createEditor();
const { state } = editor;

// App-owned wireframe presentation state (the editor owns the semantic state).
let sourceVersion = 0;
let backgroundSvg = null; // parsed <svg> element of the current wireframe
let zoom = 1;

// --- elements -----------------------------------------------------------------
const canvasEl = $('canvas');
const backgroundEl = $('background');
const spritesEl = $('sprites');
const overlay = $('overlay');
const toastEl = $('toast');
const banner = { wrap: $('error-banner'), text: $('error-text') };

const props = {
  wrap: $('box-props'), empty: $('empty-state'), boundInfo: $('bound-info'),
  label: $('prop-label'), descWrap: $('prop-desc-wrap'), desc: $('prop-desc'),
  noteWrap: $('prop-note-wrap'), note: $('prop-note'),
  type: $('prop-type'), textWrap: $('prop-text-wrap'), text: $('prop-text'),
  x: $('prop-x'), y: $('prop-y'), w: $('prop-w'), h: $('prop-h'),
  deleteBtn: $('delete-box'),
};
const ctx = { description: $('ctx-desc'), style: $('ctx-style'), background: $('ctx-bg') };
const canvasInputs = { w: $('canvas-w'), h: $('canvas-h') };

// --- helpers -------------------------------------------------------------------
let toastTimer;
const toast = (message) => {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
};

// Zoom-safe: derive the scale from the overlay's rendered size, so any CSS
// transform on #canvas is automatically accounted for.
const canvasPoint = (event) => {
  const bounds = overlay.getBoundingClientRect();
  const scaleX = bounds.width ? state.canvas.w / bounds.width : 1;
  const scaleY = bounds.height ? state.canvas.h / bounds.height : 1;
  return { x: (event.clientX - bounds.left) * scaleX, y: (event.clientY - bounds.top) * scaleY };
};

const svgEl = (tag, attrs) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
};

const isTyping = () => {
  const active = document.activeElement;
  return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
};

const syncInput = (input, value) => {
  if (document.activeElement !== input) input.value = value;
};

const rectsDiffer = (a, b) => Math.round(a.x) !== Math.round(b.x) || Math.round(a.y) !== Math.round(b.y)
  || Math.round(a.w) !== Math.round(b.w) || Math.round(a.h) !== Math.round(b.h);

// --- zoom ----------------------------------------------------------------------
const applyZoom = () => {
  canvasEl.style.transform = `scale(${zoom})`;
  canvasEl.style.transformOrigin = 'center center';
  $('zoom-fit').textContent = `${Math.round(zoom * 100)}%`;
};
const setZoom = (z) => { zoom = Math.min(Math.max(z, 0.1), 4); applyZoom(); };
const fitZoom = () => {
  const ws = $('workspace').getBoundingClientRect();
  setZoom(Math.min((ws.width - 56) / state.canvas.w, (ws.height - 56) / state.canvas.h, 1));
};
$('zoom-in').addEventListener('click', () => setZoom(zoom * 1.2));
$('zoom-out').addEventListener('click', () => setZoom(zoom / 1.2));
$('zoom-fit').addEventListener('click', fitZoom);

// --- rendering -----------------------------------------------------------------
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

const boxClasses = (box, selected) => {
  let cls = 'box-rect';
  if (box.origin === 'wireframe-bound') cls += box.deleted ? ' deleted' : ' bound';
  else if (box.type === 'text') cls += ' type-text';
  if (selected) cls += ' selected';
  return cls;
};
const chipClasses = (box) => {
  if (box.origin === 'wireframe-bound') return box.deleted ? ' deleted' : ' bound';
  return box.type === 'text' ? ' type-text' : '';
};

/**
 * Sprite drag presentation (D-014): a moved/resized bound box shows a crisp
 * vector clone of its wireframe element (the full background SVG clipped to
 * the binding rect via viewBox) at its current position, while the original
 * location renders as a dashed ghost in the overlay.
 */
let dragSprite = null; // reused during an active gesture to avoid re-cloning per move
const makeSprite = (box) => {
  if (!backgroundSvg) return null;
  const holder = document.createElement('div');
  holder.className = 'sprite';
  const clone = backgroundSvg.cloneNode(true);
  const { binding } = box;
  clone.setAttribute('viewBox', `${binding.rect.x} ${binding.rect.y} ${binding.rect.w} ${binding.rect.h}`);
  clone.setAttribute('preserveAspectRatio', 'none');
  clone.removeAttribute('id');
  clone.setAttribute('width', '100%');
  clone.setAttribute('height', '100%');
  holder.appendChild(clone);
  return holder;
};
const placeSprite = (el, rect) => {
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
};
const renderSprites = () => {
  const gestureBox = state.interaction.mode === 'dragging' || state.interaction.mode === 'resizing'
    ? editor.selectedBox() : null;

  if (gestureBox?.origin === 'wireframe-bound' && !gestureBox.deleted) {
    if (!dragSprite) {
      spritesEl.replaceChildren();
      dragSprite = makeSprite(gestureBox);
      if (dragSprite) spritesEl.appendChild(dragSprite);
    }
    if (dragSprite) placeSprite(dragSprite, gestureBox.rect);
    return;
  }
  dragSprite = null;
  spritesEl.replaceChildren();
  if (state.mode !== 'iterate' || !backgroundSvg) return;
  for (const box of state.boxes) {
    if (box.origin !== 'wireframe-bound' || box.deleted || !rectsDiffer(box.rect, box.binding.rect)) continue;
    const sprite = makeSprite(box);
    if (sprite) {
      placeSprite(sprite, box.rect);
      spritesEl.appendChild(sprite);
    }
  }
};

function render() {
  canvasEl.style.width = `${state.canvas.w}px`;
  canvasEl.style.height = `${state.canvas.h}px`;
  overlay.setAttribute('viewBox', `0 0 ${state.canvas.w} ${state.canvas.h}`);
  overlay.setAttribute('width', state.canvas.w);
  overlay.setAttribute('height', state.canvas.h);
  overlay.replaceChildren();

  for (const box of state.boxes) {
    const g = svgEl('g', {});
    const { x, y, w, h } = box.rect;
    const selected = box.id === state.selectedId;

    // Ghost at the original location for moved bound boxes (D-014).
    if (box.origin === 'wireframe-bound' && !box.deleted && rectsDiffer(box.rect, box.binding.rect)) {
      const o = box.binding.rect;
      g.appendChild(svgEl('rect', { x: o.x, y: o.y, width: o.w, height: o.h, class: 'ghost' }));
    }

    g.appendChild(svgEl('rect', { x, y, width: w, height: h, class: boxClasses(box, selected) }));

    // Label chip — outside-above when the box is too small to host it.
    const chipW = Math.max(26, box.label.length * 6.6 + 10);
    const chipInside = h >= 20 && w >= chipW + 4;
    const chipY = Math.max(chipInside ? y + 2 : y - 17, 0);
    g.appendChild(svgEl('rect', { x: x + 2, y: chipY, width: chipW, height: 15, class: `box-chip-bg${chipClasses(box)}`, rx: 3 }));
    const chipText = svgEl('text', { x: x + 7, y: chipY + 11, class: `box-chip${box.deleted ? ' deleted' : ''}` });
    chipText.textContent = box.label;
    g.appendChild(chipText);

    if (selected) {
      g.appendChild(svgEl('rect', { x: x - 1, y: y - 1, width: w + 2, height: h + 2, class: 'selection-outline' }));
      for (const hp of Object.values(handlePoints(box.rect))) {
        g.appendChild(svgEl('rect', { x: hp.x - 3.5, y: hp.y - 3.5, width: 7, height: 7, class: 'handle' }));
      }
    }
    overlay.appendChild(g);
  }

  if (state.interaction.mode === 'drawing' && state.interaction.preview) {
    const p = state.interaction.preview;
    overlay.appendChild(svgEl('rect', { x: p.x, y: p.y, width: p.w, height: p.h, class: 'preview' }));
  }

  renderSprites();

  // Header / mode chrome
  $('mode-badge').textContent = state.mode === 'iterate' ? 'Iterate' : 'Sketch';
  $('reload-source').hidden = state.mode !== 'iterate';
  $('clear-source').hidden = state.mode !== 'iterate';
  $('load-source').hidden = state.mode === 'iterate';
  $('save').textContent = state.mode === 'iterate' ? 'Save edits for AI' : 'Save for AI';

  // Sidebar
  const box = editor.selectedBox();
  props.wrap.hidden = !box;
  props.empty.hidden = !!box;
  if (box) {
    const bound = box.origin === 'wireframe-bound';
    props.boundInfo.hidden = !bound;
    if (bound) {
      props.boundInfo.textContent = `Wireframe ${box.binding.kind} — source line ${box.binding.line}${box.deleted ? ' — MARKED DELETED' : ''}`;
    }
    props.label.disabled = bound;
    props.type.disabled = bound;
    props.descWrap.hidden = bound;
    props.noteWrap.hidden = !bound;
    props.deleteBtn.textContent = bound ? (box.deleted ? 'Restore' : 'Mark deleted') : 'Delete box';
    syncInput(props.label, box.label);
    if (!bound) syncInput(props.desc, box.description);
    else syncInput(props.note, box.note ?? '');
    syncInput(props.type, box.type);
    props.textWrap.hidden = bound || box.type !== 'text';
    syncInput(props.text, box.text);
    syncInput(props.x, Math.round(box.rect.x));
    syncInput(props.y, Math.round(box.rect.y));
    syncInput(props.w, Math.round(box.rect.w));
    syncInput(props.h, Math.round(box.rect.h));
  }
  const busy = state.interaction.mode !== 'idle';
  for (const input of [props.x, props.y, props.w, props.h]) input.disabled = busy;

  syncInput(ctx.description, state.context.description);
  syncInput(ctx.style, state.context.style);
  syncInput(ctx.background, state.context.background);
  syncInput(canvasInputs.w, state.canvas.w);
  syncInput(canvasInputs.h, state.canvas.h);
  canvasInputs.w.disabled = state.mode === 'iterate'; // canvas follows the wireframe
  canvasInputs.h.disabled = state.mode === 'iterate';

  const counts = state.mode === 'iterate'
    ? `${state.boxes.length} elements — ${editor.toPayload().edits.length} pending edit(s)`
    : `${state.boxes.length} box${state.boxes.length === 1 ? '' : 'es'}`;
  $('box-count').textContent = `${counts} — ${state.canvas.w} × ${state.canvas.h} canvas`;
}

function updateCursor(point) {
  if (state.interaction.mode !== 'idle') return;
  const selected = editor.selectedBox();
  const handle = selected ? handleAt(point, selected.rect) : null;
  if (handle) overlay.style.cursor = CURSORS[handle];
  else if (boxesAt(state.boxes, point).length) overlay.style.cursor = 'move';
  else overlay.style.cursor = 'crosshair';
}

// --- wireframe loading -----------------------------------------------------------
const showError = (message) => {
  banner.text.textContent = message;
  banner.wrap.hidden = false;
};
$('dismiss-error').addEventListener('click', () => { banner.wrap.hidden = true; });
$('copy-error').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(banner.text.textContent);
    toast('Error copied — paste it to the AI.');
  } catch {
    window.prompt('Copy manually:', banner.text.textContent);
  }
});

const applySource = (text) => {
  let wf;
  try {
    wf = loadWireframe(text);
  } catch (err) {
    const where = err.line ? ` (line ${err.line}, col ${err.column})` : '';
    showError(`Wireframe failed to parse${where}: ${err.message}. If the AI used newer Wireloom primitives, re-vendor with npm run vendor.`);
    return false; // previous state stays untouched
  }
  banner.wrap.hidden = true;
  sourceVersion += 1;
  editor.loadWireframe({ bindings: wf.bindings, size: wf.size, sourceText: text, version: sourceVersion });
  backgroundEl.innerHTML = wf.svg;
  backgroundSvg = backgroundEl.querySelector('svg');
  // The SVG keeps its intrinsic (exact, possibly fractional) size so background
  // pixels align 1:1 with binding coordinates; the ceiled canvas may show a
  // sub-pixel margin at the far edges instead of stretching (review fix).
  fitZoom();
  render();
  toast(`Wireframe loaded (v${sourceVersion}) — ${wf.bindings.length} elements bound.`);
  return true;
};

const fetchSource = async ({ confirmFlush } = {}) => {
  if (confirmFlush && editor.pendingEdits()
    && !window.confirm('Reloading flushes your pending edits (they apply to the previous wireframe version). Continue?')) {
    return;
  }
  try {
    const res = await fetch('source');
    if (res.status === 404) {
      toast('No source.wireloom in the exchange folder yet — ask the AI to write one.');
      return;
    }
    applySource(await res.text());
  } catch {
    toast('Could not reach the launcher to read source.wireloom.');
  }
};
$('load-source').addEventListener('click', () => fetchSource({ confirmFlush: false }));
$('reload-source').addEventListener('click', () => fetchSource({ confirmFlush: true }));
$('clear-source').addEventListener('click', () => {
  if (editor.pendingEdits() && !window.confirm('Clearing the wireframe discards your pending edits. Continue?')) return;
  editor.clearWireframe();
  backgroundEl.replaceChildren();
  backgroundSvg = null;
  render();
});

// --- pointer wiring -------------------------------------------------------------
// One gesture, one pointer: a second concurrent pointer (palm touch) must not
// hijack or commit the active gesture (review fix).
let activePointer = null;

overlay.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || activePointer !== null) return;
  // Commit any pending sidebar edit to the CURRENTLY selected box before the
  // press can change selection (wrong-box commit review fix).
  if (isTyping()) document.activeElement.blur();
  activePointer = event.pointerId;
  overlay.setPointerCapture(event.pointerId);
  editor.pointerDown(canvasPoint(event));
  render();
});

overlay.addEventListener('pointermove', (event) => {
  if (activePointer !== null && event.pointerId !== activePointer) return;
  const point = canvasPoint(event);
  editor.pointerMove(point);
  updateCursor(point);
  if (state.interaction.mode !== 'idle') render();
});

const finishPointer = (event) => {
  if (event.pointerId !== activePointer) return;
  activePointer = null;
  if (state.interaction.mode === 'idle') return;
  const effect = editor.pointerUp(canvasPoint(event));
  render();
  if (effect === 'focus-description') (state.mode === 'iterate' ? props.desc : props.desc).focus();
};
overlay.addEventListener('pointerup', finishPointer);
overlay.addEventListener('pointercancel', finishPointer);
// Pointer leaves the window mid-drag: commit at last position (lifecycle rule).
window.addEventListener('blur', () => {
  activePointer = null;
  if (state.interaction.mode !== 'idle') {
    editor.pointerUp();
    render();
  }
});

// --- keyboard --------------------------------------------------------------------
// Escape in a field must CANCEL the pending edit, not commit it via blur
// (review fix): restore the field from state, then blur with change suppressed.
let cancelingEdit = false;
const cancelFieldEdit = (el) => {
  cancelingEdit = true;
  if (el.__resync) el.__resync();
  el.blur();
  cancelingEdit = false;
  render();
};

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (isTyping()) {
      cancelFieldEdit(document.activeElement);
      return;
    }
    editor.escape();
    render();
    return;
  }
  if (isTyping()) return; // native editing keeps its own keys, incl. Ctrl+Z
  if (event.key === 'Delete' || event.key === 'Backspace') {
    editor.deleteSelection();
    render();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    event.preventDefault();
    editor.undo();
    render();
  } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) {
    event.preventDefault();
    editor.redo();
    render();
  }
});

// --- sidebar wiring ----------------------------------------------------------------
const boxFieldValue = (box, field) => {
  if (field === 'label') return box.label;
  if (field === 'description') return box.description;
  if (field === 'note') return box.note ?? '';
  if (field === 'text') return box.text;
  if (field === 'type') return box.type;
  return Math.round(box.rect[field]);
};

const bindBoxField = (input, field) => {
  input.__resync = () => {
    const box = editor.selectedBox();
    if (box) input.value = boxFieldValue(box, field);
  };
  input.addEventListener('change', () => {
    if (cancelingEdit) return;
    editor.setBoxField(field, input.value);
    render();
    input.__resync(); // even while focused: rejected/clamped edits must not display stale text (review fix)
  });
};
bindBoxField(props.label, 'label');
bindBoxField(props.desc, 'description');
bindBoxField(props.note, 'note');
bindBoxField(props.type, 'type');
bindBoxField(props.text, 'text');
bindBoxField(props.x, 'x');
bindBoxField(props.y, 'y');
bindBoxField(props.w, 'w');
bindBoxField(props.h, 'h');
props.deleteBtn.addEventListener('click', () => { editor.deleteSelection(); render(); });

for (const [field, input] of Object.entries(ctx)) {
  input.__resync = () => { input.value = state.context[field]; };
  input.addEventListener('change', () => {
    if (cancelingEdit) return;
    editor.setContextField(field, input.value);
    render();
  });
}
const bindCanvasInput = (input) => {
  input.__resync = () => { input.value = input === canvasInputs.w ? state.canvas.w : state.canvas.h; };
  input.addEventListener('change', () => {
    if (cancelingEdit) return;
    if (!editor.setCanvasSize(canvasInputs.w.value, canvasInputs.h.value)) toast('Canvas size must be at least 64 × 64');
    render();
    canvasInputs.w.__resync();
    canvasInputs.h.__resync();
  });
};
bindCanvasInput(canvasInputs.w);
bindCanvasInput(canvasInputs.h);

// --- export actions -----------------------------------------------------------------
$('save').addEventListener('click', async () => {
  const kind = state.mode === 'iterate' ? 'packet' : 'boxes';
  const payload = editor.toPayload();
  try {
    const res = await fetch('save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) toast(`Saved ${kind}.json to the exchange folder — the AI can read it now.`);
    else toast(`Save failed (${res.status}): ${body.error ?? 'unknown error'} — try Copy JSON instead.`);
  } catch {
    toast('Save failed: the launcher is not reachable — use Copy JSON instead.');
  }
});

$('copy-json').addEventListener('click', async () => {
  const json = JSON.stringify(editor.toPayload(), null, 2);
  try {
    await navigator.clipboard.writeText(json);
    toast('JSON copied to clipboard.');
  } catch {
    window.prompt('Clipboard unavailable — copy manually:', json);
  }
});

// --- expose for scripted verification (harmless in normal use) -----------------------
window.__boundbox = { editor, render, applySource, setZoom, fitZoom };

render();
