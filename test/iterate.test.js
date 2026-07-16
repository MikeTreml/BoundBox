import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadWireframe } from '../src/wireframe.mjs';
import { createEditor } from '../src/editor.mjs';

const source = readFileSync(new URL('../fixtures/boundbox-mockup.wireloom', import.meta.url), 'utf8');

const freshIterateEditor = () => {
  const wf = loadWireframe(source);
  const ed = createEditor();
  ed.loadWireframe({ bindings: wf.bindings, size: wf.size, sourceText: source, version: 1 });
  return { ed, wf };
};

describe('wireframe bindings (bindable-element policy)', () => {
  const wf = loadWireframe(source);

  it('binds leaves and titled containers, never anonymous layout nodes', () => {
    const kinds = new Set(wf.bindings.map((b) => b.kind));
    expect(kinds.has('kv')).toBe(true);
    expect(kinds.has('slot')).toBe(true);
    expect(kinds.has('section')).toBe(true);
    expect(kinds.has('row')).toBe(false);
    expect(kinds.has('col')).toBe(false);
    expect(kinds.has('panel')).toBe(false);
    expect(kinds.has('window')).toBe(false);
  });

  it('every binding carries a source line and a positive rect', () => {
    for (const b of wf.bindings) {
      expect(b.line).toBeGreaterThan(0);
      expect(b.rect.w).toBeGreaterThan(0);
      expect(b.rect.h).toBeGreaterThan(0);
    }
    const kvX = wf.bindings.find((b) => b.kind === 'kv' && b.label === 'X');
    expect(kvX?.line).toBe(29);
  });

  it('throws WireloomError with position on a broken source', () => {
    try {
      loadWireframe('window:\n\tbad');
      expect.unreachable();
    } catch (err) {
      expect(err.line).toBeGreaterThan(0);
    }
  });
});

describe('iterate mode editing and packet', () => {
  it('load materializes bound boxes, adopts canvas size, clears undo', () => {
    const { ed, wf } = freshIterateEditor();
    expect(ed.state.mode).toBe('iterate');
    expect(ed.state.boxes).toHaveLength(wf.bindings.length);
    expect(ed.state.canvas).toEqual(wf.size);
    expect(ed.undo()).toBe(false); // source loads are not undoable (D-011)
    expect(ed.pendingEdits()).toBe(false); // fresh load: no diffs
  });

  it('bound-box moves, deletes (toggle), and notes become the right edits', () => {
    const { ed } = freshIterateEditor();
    const kvX = ed.state.boxes.find((b) => b.binding?.kind === 'kv' && b.binding.label === 'X');
    const slot = ed.state.boxes.find((b) => b.binding?.kind === 'slot' && b.binding.label === 'hero');

    // Move kv "X" 50px right via property edit.
    ed.state.selectedId = kvX.id;
    ed.setBoxField('x', String(Math.round(kvX.rect.x) + 50));
    // Mark the hero slot deleted, then annotate the cta slot.
    ed.state.selectedId = slot.id;
    ed.deleteSelection();
    const cta = ed.state.boxes.find((b) => b.binding?.kind === 'slot' && b.binding.label === 'cta');
    ed.state.selectedId = cta.id;
    ed.setBoxField('note', 'make this a tree, not a slot');

    const payload = ed.toPayload();
    expect(payload.profile).toBe('iterate');
    expect(payload.source_version).toBe(1);
    expect(payload.wireframe_source).toContain('window "BoundBox');

    const ops = payload.edits.map((e) => e.op);
    expect(ops).toContain('move');
    expect(ops).toContain('delete');
    expect(ops).toContain('annotate');
    const del = payload.edits.find((e) => e.op === 'delete');
    expect(del.target).toMatchObject({ kind: 'slot', label: 'hero', line: slot.binding.line });

    // Delete again restores (toggle) and removes the edit.
    ed.state.selectedId = slot.id;
    ed.deleteSelection();
    expect(ed.toPayload().edits.some((e) => e.op === 'delete')).toBe(false);
  });

  it('bound labels/types are read-only; geometry diffs collapse (state-diff merge)', () => {
    const { ed } = freshIterateEditor();
    const box = ed.state.boxes.find((b) => b.binding?.kind === 'kv');
    ed.state.selectedId = box.id;
    expect(ed.setBoxField('label', 'nope')).toBe(false);
    expect(ed.setBoxField('type', 'text')).toBe(false);

    // Two successive moves produce ONE edit with the final geometry.
    const x0 = Math.round(box.rect.x);
    ed.setBoxField('x', String(x0 + 20));
    ed.setBoxField('x', String(x0 + 40));
    const moves = ed.toPayload().edits.filter((e) => e.op === 'move');
    expect(moves).toHaveLength(1);

    // Undo covers bound edits (overlay-only stack).
    ed.undo();
    ed.undo();
    expect(ed.toPayload().edits.filter((e) => e.op === 'move')).toHaveLength(0);
  });

  it('user-drawn boxes in iterate mode export as add edits', () => {
    const { ed } = freshIterateEditor();
    // Draw on an empty spot (top-left margin of the laid canvas).
    ed.pointerDown({ x: 2, y: 2 });
    ed.pointerMove({ x: 60, y: 40 });
    ed.pointerUp({ x: 60, y: 40 });
    const added = ed.state.boxes.find((b) => b.origin !== 'wireframe-bound');
    expect(added).toBeDefined();
    ed.setBoxField('description', 'status readout for cursor position');

    const adds = ed.toPayload().edits.filter((e) => e.op === 'add');
    expect(adds).toHaveLength(1);
    expect(adds[0].desc).toBe('status readout for cursor position');
    expect(ed.pendingEdits()).toBe(true);
  });

  it('reloading a new source version flushes everything (D-005)', () => {
    const { ed, wf } = freshIterateEditor();
    const box = ed.state.boxes.find((b) => b.binding?.kind === 'kv');
    ed.state.selectedId = box.id;
    ed.setBoxField('x', String(Math.round(box.rect.x) + 50));
    expect(ed.pendingEdits()).toBe(true);

    ed.loadWireframe({ bindings: wf.bindings, size: wf.size, sourceText: source, version: 2 });
    expect(ed.pendingEdits()).toBe(false);
    expect(ed.toPayload().source_version).toBe(2);
    expect(ed.undo()).toBe(false);
  });

  it('first load from sketch mode PRESERVES user boxes as pending adds (review fix)', () => {
    const wf = loadWireframe(source);
    const ed = createEditor();
    ed.pointerDown({ x: 100, y: 100 });
    ed.pointerMove({ x: 200, y: 160 });
    ed.pointerUp({ x: 200, y: 160 });
    ed.setBoxField('description', 'sketched before the wireframe existed');

    ed.loadWireframe({ bindings: wf.bindings, size: wf.size, sourceText: source, version: 1 });
    const kept = ed.state.boxes.filter((b) => b.origin !== 'wireframe-bound');
    expect(kept).toHaveLength(1);
    expect(kept[0].description).toBe('sketched before the wireframe existed');
    const adds = ed.toPayload().edits.filter((e) => e.op === 'add');
    expect(adds).toHaveLength(1);

    // Iterate -> iterate reload still flushes everything (D-005).
    ed.loadWireframe({ bindings: wf.bindings, size: wf.size, sourceText: source, version: 2 });
    expect(ed.state.boxes.filter((b) => b.origin !== 'wireframe-bound')).toHaveLength(0);
  });

  it('delete supersedes prior moves and notes in the packet', () => {
    const { ed } = freshIterateEditor();
    const box = ed.state.boxes.find((b) => b.binding?.kind === 'kv');
    ed.state.selectedId = box.id;
    ed.setBoxField('x', String(Math.round(box.rect.x) + 40));
    ed.setBoxField('note', 'move this somewhere better');
    ed.deleteSelection();

    const edits = ed.toPayload().edits;
    expect(edits).toHaveLength(1);
    expect(edits[0].op).toBe('delete');
  });

  it('notes trim; whitespace-only notes emit no annotate edit', () => {
    const { ed } = freshIterateEditor();
    const box = ed.state.boxes.find((b) => b.binding?.kind === 'kv');
    ed.state.selectedId = box.id;
    ed.setBoxField('note', '   ');
    expect(ed.toPayload().edits).toHaveLength(0);
    ed.setBoxField('note', '  wider please  ');
    const annotate = ed.toPayload().edits.find((e) => e.op === 'annotate');
    expect(annotate.note).toBe('wider please');
  });

  it('resize-only emits op resize with w/h only; move-only emits x/y only', () => {
    const { ed } = freshIterateEditor();
    const box = ed.state.boxes.find((b) => b.binding?.kind === 'image');
    ed.state.selectedId = box.id;
    ed.setBoxField('w', String(Math.round(box.rect.w) - 30));
    let [edit] = ed.toPayload().edits;
    expect(edit.op).toBe('resize');
    expect(Object.keys(edit.to).sort()).toEqual(['h', 'w']);

    ed.undo();
    ed.setBoxField('x', String(Math.round(box.rect.x) + 30));
    [edit] = ed.toPayload().edits;
    expect(edit.op).toBe('move');
    expect(Object.keys(edit.to).sort()).toEqual(['x', 'y']);
  });

  it('an added text-type box carries its literal text in the add edit', () => {
    const { ed } = freshIterateEditor();
    ed.pointerDown({ x: 2, y: 2 });
    ed.pointerMove({ x: 80, y: 30 });
    ed.pointerUp({ x: 80, y: 30 });
    ed.setBoxField('type', 'text');
    ed.setBoxField('text', 'Buy now');
    const [add] = ed.toPayload().edits.filter((e) => e.op === 'add');
    expect(add.text).toBe('Buy now');
  });

  it('delete-toggle round-trips through undo/redo', () => {
    const { ed } = freshIterateEditor();
    const box = ed.state.boxes.find((b) => b.binding?.kind === 'kv');
    ed.state.selectedId = box.id;
    ed.deleteSelection();
    expect(box.deleted).toBe(true);
    ed.undo();
    expect(ed.state.boxes.find((b) => b.id === box.id).deleted).toBe(false);
    ed.redo();
    expect(ed.state.boxes.find((b) => b.id === box.id).deleted).toBe(true);
  });

  it('moving a sub-8px bound element never inflates it into a phantom resize (review fix)', () => {
    const tiny = { line: 5, column: 3, kind: 'text', label: 'a', rect: { x: 10, y: 10, w: 7.2, h: 6.5 }, depth: 1 };
    const ed = createEditor();
    ed.loadWireframe({ bindings: [tiny], size: { w: 400, h: 300 }, sourceText: 'window:\n  text "a"\n', version: 1 });
    const box = ed.state.boxes[0];
    ed.state.selectedId = box.id;
    ed.setBoxField('y', '50'); // pure move via property edit
    const edits = ed.toPayload().edits;
    expect(edits).toHaveLength(1);
    expect(edits[0].op).toBe('move');
    expect(edits[0].to.w).toBeUndefined();
    expect(box.rect.w).toBeCloseTo(7.2);
  });

  // App-level behaviors intentionally not covered headless (verified in the live
  // scripted session instead): reload/clear confirm dialogs, sourceVersion
  // increments across fetches, error-banner rendering, sprite/ghost DOM.

  it('clearWireframe returns to sketch mode keeping only user boxes', () => {
    const { ed } = freshIterateEditor();
    ed.pointerDown({ x: 2, y: 2 });
    ed.pointerMove({ x: 60, y: 40 });
    ed.pointerUp({ x: 60, y: 40 });
    ed.clearWireframe();
    expect(ed.state.mode).toBe('sketch');
    expect(ed.state.boxes).toHaveLength(1);
    expect(ed.state.boxes[0].origin).not.toBe('wireframe-bound');
    expect(ed.toPayload().boxes).toHaveLength(1); // sketch profile again
  });
});
