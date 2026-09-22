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
import { validateProject } from './project.mjs';
import { editsForBox } from './packet.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const editor = createEditor();
const { state } = editor;

// App-owned wireframe presentation state (the editor owns the semantic state).
let sourceVersion = 0;
let backgroundSvg = null; // parsed <svg> element of the current wireframe
let zoom = 1;
let pan = { x: 24, y: 24 };
let spaceHeld = false;
let altHeld = false;
let overlayHidden = false;
let viewPanning = null;
let listPendingOnly = false;

// --- elements -----------------------------------------------------------------
const canvasEl = $('canvas');
const backgroundEl = $('background');
const spritesEl = $('sprites');
const overlay = $('overlay');
const toastEl = $('toast');
const banner = { wrap: $('error-banner'), text: $('error-text') };
const projectUi = {
  name: $('project-name'), dirty: $('dirty-dot'),
  open: $('open-project'), save: $('save-project'),
};

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

// --- project dirty state -------------------------------------------------------
// Fingerprints deliberately omit selection, interaction, and undo history. Undo
// back to the saved document therefore becomes clean without bookkeeping in
// every editor command.
let cleanProjectJson;
let hasProjectFile = false;
let serviceConnected = true;
const projectSnapshot = () => editor.toProject({
  zoom,
  gridLock: state.grid.locked,
  gridStep: state.grid.step,
});
const projectFingerprint = () => JSON.stringify(projectSnapshot());
const hasActiveDraft = () => {
  const active = document.activeElement;
  return typeof active?.__projectValue === 'function'
    && String(active.value) !== String(active.__projectValue());
};
const isProjectDirty = () => cleanProjectJson !== undefined
  && (projectFingerprint() !== cleanProjectJson || hasActiveDraft());
const updateProjectStatus = () => {
  const dirty = isProjectDirty();
  projectUi.dirty.hidden = !dirty;
  projectUi.name.textContent = hasProjectFile ? 'project.json' : 'New project';
  $('service-status').hidden = serviceConnected;
  $('project-status').title = dirty
    ? 'Unsaved project changes - Save project writes ./boundbox/project.json'
    : (hasProjectFile ? 'Project is saved at ./boundbox/project.json' : 'No project file saved yet');
};
const setProjectBaseline = (project, { exists = true } = {}) => {
  cleanProjectJson = JSON.stringify(project);
  hasProjectFile = exists;
  updateProjectStatus();
};

// --- zoom ----------------------------------------------------------------------
const workspaceEl = $('workspace');
const applyView = () => {
  canvasEl.style.transformOrigin = '0 0';
  canvasEl.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  $('zoom-fit').textContent = `${Math.round(zoom * 100)}%`;
};
const setZoom = (z) => {
  zoom = Math.min(Math.max(z, 0.1), 4);
  applyView();
  updateProjectStatus();
};
const fitZoom = () => {
  const ws = workspaceEl.getBoundingClientRect();
  const next = Math.min((ws.width - 56) / state.canvas.w, (ws.height - 56) / state.canvas.h, 1);
  zoom = Math.min(Math.max(next, 0.1), 4);
  pan = {
    x: (ws.width - state.canvas.w * zoom) / 2,
    y: (ws.height - state.canvas.h * zoom) / 2,
  };
  applyView();
  updateProjectStatus();
};
const frameBox = (box) => {
  const ws = workspaceEl.getBoundingClientRect();
  pan = {
    x: ws.width / 2 - (box.rect.x + box.rect.w / 2) * zoom,
    y: ws.height / 2 - (box.rect.y + box.rect.h / 2) * zoom,
  };
  applyView();
};
$('zoom-in').addEventListener('click', () => setZoom(zoom * 1.2));
$('zoom-out').addEventListener('click', () => setZoom(zoom / 1.2));
$('zoom-fit').addEventListener('click', fitZoom);

// --- rendering -----------------------------------------------------------------
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

const boxPending = (box) => {
  if (state.mode !== 'iterate') return false;
  return box.origin === 'wireframe-bound' ? editsForBox(box, state.canvas).length > 0 : true;
};
const boxClasses = (box, selected) => {
  let cls = 'box-rect';
  if (box.origin === 'wireframe-bound') cls += box.deleted ? ' deleted' : ' bound';
  else if (box.type === 'text') cls += ' type-text';
  if (boxPending(box)) cls += ' pending';
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
  overlay.classList.toggle('overlay-hidden', overlayHidden || altHeld);

  if (state.grid.locked && state.grid.step > 0 && state.canvas.w / state.grid.step <= 200 && state.canvas.h / state.grid.step <= 200) {
    const step = state.grid.step;
    for (let x = 0; x <= state.canvas.w; x += step) {
      overlay.appendChild(svgEl('line', {
        x1: x, y1: 0, x2: x, y2: state.canvas.h, stroke: '#d4d4cc', 'stroke-width': 0.5,
      }));
    }
    for (let y = 0; y <= state.canvas.h; y += step) {
      overlay.appendChild(svgEl('line', {
        x1: 0, y1: y, x2: state.canvas.w, y2: y, stroke: '#d4d4cc', 'stroke-width': 0.5,
      }));
    }
  }

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
    if (box.note?.trim()) {
      g.appendChild(svgEl('circle', { cx: x + chipW - 2, cy: chipY + 7.5, r: 3, class: 'note-dot' }));
    }

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
  const recovering = state.mode === 'sketch' && state.wireframe?.recovery;
  $('mode-badge').textContent = recovering ? 'Recovery' : (state.mode === 'iterate' ? 'Iterate' : 'Sketch');
  $('reload-source').hidden = state.mode !== 'iterate';
  $('clear-source').hidden = state.mode !== 'iterate';
  $('load-source').hidden = state.mode === 'iterate';
  $('save').textContent = recovering ? 'Repair source first' : (state.mode === 'iterate' ? 'Save edits for AI' : 'Save for AI');
  $('save').disabled = recovering;
  $('copy-json').disabled = recovering;
  $('copy-json').title = recovering ? 'Repair/reload the Wireloom source before exporting' : '';
  $('tool-select').classList.toggle('active', state.tool === 'select');
  $('tool-draw').classList.toggle('active', state.tool === 'draw');
  $('tool-pan').classList.toggle('active', state.tool === 'pan' || spaceHeld);
  $('toggle-overlay').classList.toggle('active', overlayHidden || altHeld);
  const pendingCount = state.mode === 'iterate' ? editor.toPayload().edits.length : 0;
  $('edit-count').hidden = pendingCount === 0;
  $('edit-count').textContent = `${pendingCount} edit${pendingCount === 1 ? '' : 's'}`;
  $('pending-filter-wrap').hidden = state.mode !== 'iterate';
  syncInput($('grid-step'), state.grid.step);
  $('grid-lock').checked = state.grid.locked;

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
    props.type.disabled = false;
    props.descWrap.hidden = bound;
    props.noteWrap.hidden = !bound;
    props.deleteBtn.textContent = bound ? (box.deleted ? 'Restore' : 'Mark deleted') : 'Delete box';
    syncInput(props.label, box.label);
    if (!bound) syncInput(props.desc, box.description);
    else syncInput(props.note, box.note ?? '');
    syncInput(props.type, box.type);
    props.textWrap.hidden = box.type !== 'text';
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
  renderBoxList();
  updateProjectStatus();
}

const boxListEl = $('box-list');
const boxListEmpty = $('box-list-empty');
function renderBoxList() {
  const ordered = [...state.boxes]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((box) => !listPendingOnly || boxPending(box));
  boxListEmpty.hidden = ordered.length > 0;
  boxListEl.replaceChildren();
  const userIds = ordered.filter((box) => box.origin !== 'wireframe-bound').map((box) => box.id);
  ordered.forEach((box) => {
    const item = document.createElement('li');
    const select = document.createElement('button');
    select.type = 'button';
    select.className = `box-list-label${box.id === state.selectedId ? ' selected' : ''}`;
    const mark = boxPending(box) ? ' •' : '';
    select.textContent = `${box.deleted ? `${box.label} (deleted)` : box.label}${mark}`;
    select.title = box.origin === 'wireframe-bound' ? `${box.binding.kind} line ${box.binding.line}` : box.description || box.label;
    select.addEventListener('click', () => {
      editor.state.selectedId = box.id;
      frameBox(box);
      render();
    });
    item.append(select);
    if (box.origin !== 'wireframe-bound') {
      const userIndex = userIds.indexOf(box.id);
      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '↑';
      up.title = 'Move earlier in export order';
      up.disabled = userIndex === 0;
      up.addEventListener('click', () => {
        editor.moveBox(box.id, -1);
        render();
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '↓';
      down.title = 'Move later in export order';
      down.disabled = userIndex === userIds.length - 1;
      down.addEventListener('click', () => {
        editor.moveBox(box.id, 1);
        render();
      });
      item.append(up, down);
    }
    boxListEl.appendChild(item);
  });
}

function updateCursor(point) {
  if (viewPanning || spaceHeld || state.tool === 'pan') {
    overlay.style.cursor = 'grab';
    return;
  }
  if (state.interaction.mode !== 'idle') return;
  const selected = editor.selectedBox();
  const handle = selected ? handleAt(point, selected.rect) : null;
  if (handle) overlay.style.cursor = CURSORS[handle];
  else if (boxesAt(state.boxes, point).length) overlay.style.cursor = 'move';
  else overlay.style.cursor = state.tool === 'select' ? 'default' : 'crosshair';
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
  const wasRecovering = state.mode === 'sketch' && state.wireframe?.recovery;
  const restored = wasRecovering
    ? editor.recoverWireframe({ bindings: wf.bindings, size: wf.size, sourceText: text, version: sourceVersion })
    : (editor.loadWireframe({ bindings: wf.bindings, size: wf.size, sourceText: text, version: sourceVersion }), null);
  backgroundEl.innerHTML = wf.svg;
  backgroundSvg = backgroundEl.querySelector('svg');
  // The SVG keeps its intrinsic (exact, possibly fractional) size so background
  // pixels align 1:1 with binding coordinates; the ceiled canvas may show a
  // sub-pixel margin at the far edges instead of stretching (review fix).
  fitZoom();
  render();
  if (restored?.warnings.length) {
    showError(`Repaired Wireloom loaded, but ${restored.warnings.length} pending edit(s) could not be rebound: ${restored.warnings.map(targetSummary).join('; ')}.`);
  }
  toast(`${wasRecovering ? 'Recovered' : 'Wireframe loaded'} (v${sourceVersion}) — ${wf.bindings.length} elements bound.`);
  return true;
};

const fetchSource = async ({ confirmFlush, silentMissing = false } = {}) => {
  if (confirmFlush && editor.pendingEdits()
    && !window.confirm('Reloading flushes your pending edits (they apply to the previous wireframe version). Continue?')) {
    return false;
  }
  try {
    const res = await fetch('source');
    if (res.status === 404) {
      if (!silentMissing) toast('No source.wireloom in the exchange folder yet — ask the AI to write one.');
      return false;
    }
    return applySource(await res.text());
  } catch {
    if (!silentMissing) toast('Could not reach the exchange service to read source.wireloom.');
    return false;
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
$('reset-workspace').addEventListener('click', () => {
  if (!window.confirm('Reset to a blank canvas? Saved exchange files and history will remain available.')) return;
  if (isTyping()) cancelFieldEdit(document.activeElement);
  editor.resetProject();
  sourceVersion = 0;
  backgroundEl.replaceChildren();
  backgroundSvg = null;
  banner.wrap.hidden = true;
  fitZoom();
  // With no saved file, Reset defines the clean blank workspace. With a saved
  // project, keep its baseline so Reset is visibly unsaved and Open can restore.
  if (!hasProjectFile) setProjectBaseline(projectSnapshot(), { exists: false });
  render();
  toast('Workspace reset. Saved project.json and history were not deleted.');
});

// --- pointer wiring -------------------------------------------------------------
// One gesture, one pointer: a second concurrent pointer (palm touch) must not
// hijack or commit the active gesture (review fix).
let activePointer = null;

overlay.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || activePointer !== null) return;
  if (isTyping()) document.activeElement.blur();
  activePointer = event.pointerId;
  overlay.setPointerCapture(event.pointerId);
  if (spaceHeld || state.tool === 'pan') {
    viewPanning = { x: event.clientX - pan.x, y: event.clientY - pan.y };
    overlay.style.cursor = 'grabbing';
    return;
  }
  editor.pointerDown(canvasPoint(event));
  render();
});

overlay.addEventListener('pointermove', (event) => {
  if (activePointer !== null && event.pointerId !== activePointer) return;
  if (viewPanning) {
    pan = { x: event.clientX - viewPanning.x, y: event.clientY - viewPanning.y };
    applyView();
    return;
  }
  const point = canvasPoint(event);
  editor.pointerMove(point);
  updateCursor(point);
  if (state.interaction.mode !== 'idle') render();
});

const finishPointer = (event) => {
  if (event.pointerId !== activePointer) return;
  activePointer = null;
  if (viewPanning) {
    viewPanning = null;
    updateCursor(canvasPoint(event));
    return;
  }
  if (state.interaction.mode === 'idle') return;
  const effect = editor.pointerUp(canvasPoint(event));
  render();
  if (effect === 'focus-description') props.desc.focus();
};
overlay.addEventListener('pointerup', finishPointer);
overlay.addEventListener('pointercancel', finishPointer);
window.addEventListener('blur', () => {
  activePointer = null;
  viewPanning = null;
  spaceHeld = false;
  altHeld = false;
  if (state.interaction.mode !== 'idle') {
    editor.pointerUp();
    render();
  }
});

workspaceEl.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    const next = Math.min(Math.max(zoom * factor, 0.1), 4);
    const bounds = overlay.getBoundingClientRect();
    const cx = event.clientX - bounds.left;
    const cy = event.clientY - bounds.top;
    const canvasX = cx / zoom;
    const canvasY = cy / zoom;
    zoom = next;
    pan = {
      x: event.clientX - workspaceEl.getBoundingClientRect().left - canvasX * zoom,
      y: event.clientY - workspaceEl.getBoundingClientRect().top - canvasY * zoom,
    };
    applyView();
    updateProjectStatus();
    return;
  }
  pan = { x: pan.x - event.deltaX, y: pan.y - event.deltaY };
  applyView();
}, { passive: false });

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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (isTyping()) document.activeElement.blur();
    saveProject();
    return;
  }
  if (event.key === ' ' && !isTyping()) {
    event.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      render();
    }
    return;
  }
  if (event.key === 'Alt' && !isTyping()) {
    altHeld = true;
    render();
    return;
  }
  if (isTyping()) return;
  if (event.key.toLowerCase() === 'v') { editor.setTool('select'); render(); return; }
  if (event.key.toLowerCase() === 'r') { editor.setTool('draw'); render(); return; }
  if (event.key.toLowerCase() === 'h') { overlayHidden = !overlayHidden; render(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    editor.duplicateSelection();
    render();
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0;
    const dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
    editor.nudge(dx, dy);
    render();
    return;
  }
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
window.addEventListener('keyup', (event) => {
  if (event.key === ' ') {
    spaceHeld = false;
    render();
  }
  if (event.key === 'Alt') {
    altHeld = false;
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
  input.__projectValue = () => {
    const box = editor.selectedBox();
    return box ? boxFieldValue(box, field) : input.value;
  };
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
  input.addEventListener('input', updateProjectStatus);
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
  input.__projectValue = () => state.context[field];
  input.__resync = () => { input.value = state.context[field]; };
  input.addEventListener('change', () => {
    if (cancelingEdit) return;
    editor.setContextField(field, input.value);
    render();
  });
  input.addEventListener('input', updateProjectStatus);
}
const bindCanvasInput = (input) => {
  input.__projectValue = () => (input === canvasInputs.w ? state.canvas.w : state.canvas.h);
  input.__resync = () => { input.value = input === canvasInputs.w ? state.canvas.w : state.canvas.h; };
  input.addEventListener('change', () => {
    if (cancelingEdit) return;
    if (!editor.setCanvasSize(canvasInputs.w.value, canvasInputs.h.value)) toast('Canvas size must be at least 64 × 64');
    render();
    canvasInputs.w.__resync();
    canvasInputs.h.__resync();
  });
  input.addEventListener('input', updateProjectStatus);
};
bindCanvasInput(canvasInputs.w);
bindCanvasInput(canvasInputs.h);
$('grid-lock').addEventListener('change', () => {
  editor.setGridLock($('grid-lock').checked);
  render();
});
$('grid-step').addEventListener('change', () => {
  if (!editor.setGridStep($('grid-step').value)) toast('Grid step must be a number greater than 0.');
  render();
});
$('grid-step').addEventListener('input', updateProjectStatus);
$('pending-only').addEventListener('change', () => {
  listPendingOnly = $('pending-only').checked;
  render();
});
$('tool-select').addEventListener('click', () => { editor.setTool('select'); render(); });
$('tool-draw').addEventListener('click', () => { editor.setTool('draw'); render(); });
$('tool-pan').addEventListener('click', () => { editor.setTool('pan'); render(); });
$('toggle-overlay').addEventListener('click', () => { overlayHidden = !overlayHidden; render(); });

// --- project persistence ---------------------------------------------------------
const targetSummary = (warning) => {
  const { target } = warning;
  return `line ${target.line} ${target.kind} "${target.label}"`;
};
let projectBusy = false;
const setProjectBusy = (busy) => {
  projectBusy = busy;
  projectUi.open.disabled = busy;
  projectUi.save.disabled = busy;
};

const openProject = async ({ silentMissing = false } = {}) => {
  if (projectBusy) return false;
  if (isProjectDirty() && !window.confirm('Open project.json and discard your unsaved project changes?')) return false;
  const stateBeforeFetch = projectFingerprint();
  setProjectBusy(true);
  try {
    const res = await fetch(silentMissing ? 'project?optional=1' : 'project', { cache: 'no-store' });
    if (res.status === 204 || res.status === 404) {
      if (!silentMissing) toast('No project.json in the exchange folder yet.');
      return false;
    }
    if (!res.ok) {
      toast(`Open project failed (${res.status}).`);
      return false;
    }

    let project;
    try {
      project = validateProject(JSON.parse(await res.text()));
    } catch (err) {
      showError(`Project could not be opened: ${err.message}. Your current canvas was not changed.`);
      return false;
    }

    let wf = null;
    let sourceError = null;
    if (project.mode === 'iterate') {
      try {
        wf = loadWireframe(project.wireframe.sourceText);
      } catch (err) {
        sourceError = err;
      }
    }

    // The local fetch is normally instant, but never discard an edit made
    // while it was in flight without a fresh confirmation.
    if ((projectFingerprint() !== stateBeforeFetch || hasActiveDraft())
      && !window.confirm('The canvas changed while project.json was loading. Discard those newer changes and continue?')) {
      return false;
    }
    if (isTyping()) cancelFieldEdit(document.activeElement);

    let restored;
    try {
      restored = editor.loadProject(project, wf ? { bindings: wf.bindings, size: wf.size } : {});
    } catch (err) {
      showError(`Project could not be opened: ${err.message}. Your current canvas was not changed.`);
      return false;
    }

    sourceVersion = state.wireframe?.version ?? 0;
    if (wf) {
      backgroundEl.innerHTML = wf.svg;
      backgroundSvg = backgroundEl.querySelector('svg');
    } else {
      backgroundEl.replaceChildren();
      backgroundSvg = null;
    }
    if (restored.options.gridLock !== undefined) editor.setGridLock(restored.options.gridLock);
    if (restored.options.gridStep !== undefined) editor.setGridStep(restored.options.gridStep);
    let baselineProject = project;
    if (restored.options.zoom !== undefined) {
      zoom = restored.options.zoom;
      applyView();
    } else {
      fitZoom();
      baselineProject = { ...project, options: { ...project.options, zoom } };
    }

    // Baseline the exact file that was opened. Reconciliation/fallback changes
    // remain visibly dirty because the current fingerprint will differ.
    setProjectBaseline(baselineProject);
    render();
    if (sourceError) {
      const where = sourceError.line ? ` (line ${sourceError.line}, col ${sourceError.column})` : '';
      showError(`Project opened in sketch recovery mode because its Wireloom source failed to parse${where}: ${sourceError.message}. The source is preserved in project state; save only after reviewing the recovered boxes.`);
      return true;
    }
    if (restored.warnings.length) {
      showError(`Project opened, but ${restored.warnings.length} pending edit(s) no longer matched the fresh wireframe and were dropped: ${restored.warnings.map(targetSummary).join('; ')}.`);
    } else {
      banner.wrap.hidden = true;
      toast(`Opened project.json - ${state.boxes.length} box${state.boxes.length === 1 ? '' : 'es'} restored.`);
    }
    return true;
  } catch {
    toast('Open project failed: the exchange service is not reachable.');
    return false;
  } finally {
    setProjectBusy(false);
  }
};

const saveProject = async () => {
  if (projectBusy) return false;
  const payload = projectSnapshot();
  const sentFingerprint = JSON.stringify(payload);
  setProjectBusy(true);
  try {
    const res = await fetch('save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project', payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(`Project save failed (${res.status}): ${body.error ?? 'unknown error'}.`);
      return false;
    }
    cleanProjectJson = sentFingerprint; // edits made while POST was in flight remain dirty
    hasProjectFile = true;
    updateProjectStatus();
    toast('Saved project.json - this session can now be reopened later.');
    refreshHistory({ silent: true });
    return true;
  } catch {
    toast('Project save failed: the exchange service is not reachable.');
    return false;
  } finally {
    setProjectBusy(false);
  }
};

projectUi.open.addEventListener('click', openProject);
projectUi.save.addEventListener('click', saveProject);
window.addEventListener('beforeunload', (event) => {
  if (!isProjectDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

const historyListEl = $('history-list');
const historyEmpty = $('history-empty');
let historyEntries = [];
const renderHistory = (entries) => {
  historyEntries = entries;
  historyEmpty.hidden = entries.length > 0;
  historyListEl.replaceChildren();
  [...entries].reverse().forEach((entry) => {
    const item = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const title = document.createElement('strong');
    title.textContent = `#${entry.seq} ${entry.file}`;
    meta.append(title, document.createElement('br'), document.createTextNode(`${entry.reason || ''} · ${entry.bytes} bytes`));
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.textContent = 'Restore';
    restoreBtn.title = `Restore ${entry.file} from seq ${entry.seq}`;
    restoreBtn.addEventListener('click', () => restoreHistoryEntry(entry));
    item.append(meta, restoreBtn);
    historyListEl.appendChild(item);
  });
};
const refreshHistory = async ({ silent = false } = {}) => {
  try {
    const res = await fetch('history', { cache: 'no-store' });
    if (!res.ok) throw new Error(`history failed (${res.status})`);
    const body = await res.json();
    renderHistory(Array.isArray(body.entries) ? body.entries : []);
    if (!silent) toast(`History: ${historyEntries.length} journal ${historyEntries.length === 1 ? 'entry' : 'entries'}.`);
  } catch {
    if (!silent) toast('Could not read history from the exchange service.');
  }
};
const restoreHistoryEntry = async (entry) => {
  if (!window.confirm(`Restore ${entry.file} from seq ${entry.seq}? Unjournaled live content is preserved first.`)) return;
  try {
    const res = await fetch('restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: entry.seq }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(`Restore failed (${res.status}): ${body.error ?? 'unknown error'}.`);
      return;
    }
    await refreshHistory({ silent: true });
    if (entry.file === 'project.json') {
      toast(`Restored project.json (seq ${entry.seq}). Opening it.`);
      await openProject();
      return;
    }
    if (entry.file === 'source.wireloom') {
      const loaded = await fetchSource({ confirmFlush: true, silentMissing: true });
      toast(loaded
        ? `Restored source.wireloom (seq ${entry.seq}) and loaded it.`
        : `Restored source.wireloom (seq ${entry.seq}).`);
      return;
    }
    toast(`Restored ${entry.file} (seq ${entry.seq}) in the exchange folder.`);
  } catch {
    toast('Restore failed: the exchange service is not reachable.');
  }
};
$('refresh-history').addEventListener('click', () => refreshHistory());

// Keep the on-demand Python service alive while this UI is actually present. The service
// reports its timeout so even deliberately short preview settings remain safe.
// Closing the pane stops heartbeats and normal idle cleanup resumes.
let heartbeatTimer;
let heartbeatInFlight = false;
const heartbeat = async () => {
  if (heartbeatInFlight) return;
  clearTimeout(heartbeatTimer);
  heartbeatInFlight = true;
  let nextDelay = 5_000;
  try {
    const res = await fetch('ping', { cache: 'no-store' });
    if (!res.ok) throw new Error(`heartbeat failed (${res.status})`);
    const body = await res.json();
    const timeoutMs = Number(body.idleSeconds) * 1000;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      nextDelay = Math.max(250, Math.min(60_000, Math.floor(timeoutMs / 3)));
    }
    if (!serviceConnected) {
      serviceConnected = true;
      updateProjectStatus();
      toast('Launcher reconnected.');
    }
  } catch {
    if (serviceConnected) {
      serviceConnected = false;
      updateProjectStatus();
      toast('Launcher disconnected - Refresh or relaunch BoundBox if it does not recover.');
    }
  } finally {
    heartbeatInFlight = false;
    heartbeatTimer = setTimeout(heartbeat, nextDelay);
  }
};
heartbeat();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') heartbeat();
});
refreshHistory({ silent: true });

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
    if (res.ok) {
      toast(`Saved ${kind}.json to the exchange folder — the AI can read it now.`);
      refreshHistory({ silent: true });
    }
    else toast(`Save failed (${res.status}): ${body.error ?? 'unknown error'} — try Copy JSON instead.`);
  } catch {
    toast('Save failed: the exchange service is not reachable — use Copy JSON instead.');
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
window.__boundbox = {
  editor, render, applySource, setZoom, fitZoom,
  openProject, saveProject, isProjectDirty,
  refreshHistory, restoreHistoryEntry,
};

setProjectBaseline(projectSnapshot(), { exists: false });
render();
fitZoom();
const bootWorkspace = async () => {
  const opened = await openProject({ silentMissing: true });
  if (!opened) await fetchSource({ confirmFlush: false, silentMissing: true });
};
bootWorkspace();
