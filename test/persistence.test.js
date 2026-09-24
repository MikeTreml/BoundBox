import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEditor } from '../src/editor.mjs';
import { loadWireframe } from '../src/wireframe.mjs';

const source = readFileSync(new URL('../fixtures/boundbox-mockup.wireloom', import.meta.url), 'utf8');

const draw = (editor, from, to) => {
  editor.pointerDown(from);
  editor.pointerMove(to);
  editor.pointerUp(to);
};

const iterateEditor = () => {
  const wireframe = loadWireframe(source);
  const editor = createEditor();
  editor.loadWireframe({
    bindings: wireframe.bindings,
    size: wireframe.size,
    sourceText: source,
    version: 7,
  });
  return { editor, wireframe };
};

describe('project persistence', () => {
  it('round-trips a sketch project exactly while clearing transient state', () => {
    const editor = createEditor({ canvas: { w: 900, h: 700 } });
    draw(editor, { x: 40, y: 60 }, { x: 300, y: 220 });
    editor.setBoxField('label', 'hero');
    editor.setBoxField('description', 'Product screenshot');
    editor.setContextField('description', 'Landing page');
    editor.setContextField('style', 'quiet and technical');
    const project = editor.toProject({ zoom: 0.75 });

    const reopened = createEditor();
    draw(reopened, { x: 1, y: 1 }, { x: 50, y: 50 }); // must be replaced, not merged
    const result = reopened.loadProject(project);

    expect(result.options).toEqual({ zoom: 0.75 });
    expect(reopened.toProject({ zoom: 0.75 })).toEqual(project);
    expect(reopened.state.selectedId).toBeNull();
    expect(reopened.state.interaction).toEqual({ mode: 'idle' });
    expect(reopened.undo()).toBe(false);
  });

  it('round-trips every kind of pending iterate intent into an identical packet', () => {
    const { editor, wireframe } = iterateEditor();
    const moved = editor.state.boxes.find((box) => box.binding.kind === 'kv');
    const deleted = editor.state.boxes.find((box) => box.binding.kind === 'slot');
    const annotated = editor.state.boxes.find((box) => box.binding.kind === 'image');

    editor.state.selectedId = moved.id;
    editor.setBoxField('x', String(moved.rect.x + 23.25));
    editor.setBoxField('w', String(moved.rect.w + 11.5));
    editor.state.selectedId = deleted.id;
    editor.deleteSelection();
    editor.state.selectedId = annotated.id;
    editor.setBoxField('note', 'make the illustration calmer');
    draw(editor, { x: 2, y: 2 }, { x: 65, y: 44 });
    editor.setBoxField('description', 'new status summary');

    const expectedPacket = editor.toPayload();
    const project = editor.toProject({ zoom: 0.6 });
    const reopened = createEditor();
    const result = reopened.loadProject(project, {
      bindings: wireframe.bindings,
      size: wireframe.size,
    });

    expect(result.warnings).toEqual([]);
    expect(reopened.toPayload()).toEqual(expectedPacket);
    expect(reopened.toProject({ zoom: 0.6 })).toEqual(project);
    expect(reopened.state.wireframe.version).toBe(7);
    expect(reopened.state.selectedId).toBeNull();
    expect(reopened.undo()).toBe(false);
  });

  it('reconciles edited axes onto fresh layout while keeping untouched fresh axes', () => {
    const { editor, wireframe } = iterateEditor();
    const savedBox = editor.state.boxes.find((box) => box.binding.kind === 'kv');
    const old = { ...savedBox.binding.rect };
    editor.state.selectedId = savedBox.id;
    editor.setBoxField('x', String(old.x + 40.125));
    const project = editor.toProject();

    const fresh = structuredClone(wireframe.bindings);
    const freshBinding = fresh.find((binding) => (
      binding.line === savedBox.binding.line
      && binding.kind === savedBox.binding.kind
      && binding.label === savedBox.binding.label
    ));
    freshBinding.rect.y += 9;
    freshBinding.rect.w += 7;

    const reopened = createEditor();
    reopened.loadProject(project, { bindings: fresh, size: wireframe.size });
    const restored = reopened.state.boxes.find((box) => box.binding.line === savedBox.binding.line);
    expect(restored.rect.x).toBe(old.x + 40.125); // persisted edit
    expect(restored.rect.y).toBe(freshBinding.rect.y); // fresh untouched axis
    expect(restored.rect.w).toBe(freshBinding.rect.w); // fresh untouched axis
  });

  it('drops and reports an edited target that no longer exists', () => {
    const { editor, wireframe } = iterateEditor();
    const target = editor.state.boxes.find((box) => box.binding.kind === 'kv');
    editor.state.selectedId = target.id;
    editor.setBoxField('note', 'remove this field');
    const project = editor.toProject();
    const fresh = wireframe.bindings.filter((binding) => !(
      binding.line === target.binding.line
      && binding.kind === target.binding.kind
      && binding.label === target.binding.label
    ));

    const reopened = createEditor();
    const result = reopened.loadProject(project, { bindings: fresh, size: wireframe.size });
    expect(result.warnings).toEqual([{
      code: 'dropped-edit',
      target: {
        line: target.binding.line,
        kind: target.binding.kind,
        label: target.binding.label || target.binding.kind,
      },
    }]);
    expect(reopened.state.boxes.some((box) => box.binding?.line === target.binding.line)).toBe(false);
  });

  it('never guesses when line+kind+label targets are ambiguous', () => {
    const bindings = [
      { line: 4, column: 2, kind: 'text', label: 'same', rect: { x: 10, y: 10, w: 40, h: 20 }, depth: 1 },
      { line: 4, column: 20, kind: 'text', label: 'same', rect: { x: 70, y: 10, w: 40, h: 20 }, depth: 1 },
    ];
    const editor = createEditor({ canvas: { w: 300, h: 200 } });
    editor.loadWireframe({ bindings, size: { w: 300, h: 200 }, sourceText: 'window:\n  row: text "same"; text "same"\n', version: 1 });
    editor.state.selectedId = editor.state.boxes[0].id;
    editor.setBoxField('note', 'only the first one');

    const reopened = createEditor();
    const result = reopened.loadProject(editor.toProject(), { bindings, size: { w: 300, h: 200 } });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('ambiguous-edit');
    expect(reopened.state.boxes.every((box) => box.note === '')).toBe(true);
  });

  it('rejects corrupt or newer projects without changing current state', () => {
    const editor = createEditor();
    draw(editor, { x: 20, y: 20 }, { x: 120, y: 100 });
    const before = structuredClone(editor.state);
    const valid = editor.toProject();

    expect(() => editor.loadProject({ ...valid, schemaVersion: 2 })).toThrow(/newer/);
    expect(editor.state).toEqual(before);

    const outside = structuredClone(valid);
    outside.boxes[0].rect.x = outside.canvas.w;
    expect(() => editor.loadProject(outside)).toThrow(/within the saved canvas/);
    expect(editor.state).toEqual(before);

    const duplicate = structuredClone(valid);
    duplicate.boxes.push(structuredClone(duplicate.boxes[0]));
    expect(() => editor.loadProject(duplicate)).toThrow(/duplicate id/);
    expect(editor.state).toEqual(before);

    expect(() => editor.loadProject({ ...valid, counter: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/);
    expect(editor.state).toEqual(before);
  });

  it('falls back to sketch recovery without losing bound intent, then rebinds it', () => {
    const tiny = { line: 2, column: 3, kind: 'text', label: 'a', rect: { x: 10, y: 10, w: 4.5, h: 6.25 }, depth: 1 };
    const removed = { line: 3, column: 3, kind: 'button', label: 'remove', rect: { x: 30, y: 30, w: 60, h: 24 }, depth: 1 };
    const editor = createEditor({ canvas: { w: 300, h: 200 } });
    editor.loadWireframe({ bindings: [tiny, removed], size: { w: 300, h: 200 }, sourceText: 'broken future source', version: 3 });
    editor.state.selectedId = editor.state.boxes[0].id;
    editor.setBoxField('note', 'keep this annotation');
    editor.state.selectedId = editor.state.boxes[1].id;
    editor.deleteSelection();
    const project = editor.toProject();

    const reopened = createEditor();
    const result = reopened.loadProject(project); // app omits bindings after parse failure
    expect(result.fallback).toBe(true);
    expect(reopened.state.mode).toBe('sketch');
    expect(reopened.state.boxes[0].rect).toEqual(tiny.rect);
    expect(reopened.state.boxes[0]).toMatchObject({ origin: 'wireframe-bound', note: 'keep this annotation' });
    expect(reopened.state.boxes[1]).toMatchObject({ origin: 'wireframe-bound', deleted: true });
    expect(reopened.state.wireframe).toMatchObject({ sourceText: 'broken future source', recovery: true });
    expect(() => reopened.toProject()).not.toThrow();

    const rebound = reopened.recoverWireframe({
      bindings: [tiny, removed],
      size: { w: 300, h: 200 },
      sourceText: 'fixed source',
      version: 4,
    });
    expect(rebound.warnings).toEqual([]);
    expect(reopened.state.mode).toBe('iterate');
    expect(reopened.state.wireframe).toMatchObject({ sourceText: 'fixed source', version: 4 });
    expect(reopened.toPayload().edits.map((edit) => edit.op)).toEqual(['annotate', 'delete']);
  });

  it('does not manufacture an edit from a sub-pixel change the packet ignores', () => {
    const binding = { line: 2, column: 3, kind: 'text', label: 'a', rect: { x: 10.2, y: 10, w: 20, h: 10 }, depth: 1 };
    const editor = createEditor({ canvas: { w: 300, h: 200 } });
    editor.loadWireframe({ bindings: [binding], size: { w: 300, h: 200 }, sourceText: 'source', version: 1 });
    editor.state.boxes[0].rect.x = 10.4; // same rounded pixel, therefore no packet edit
    expect(editor.toPayload().edits).toEqual([]);

    const fresh = [{ ...binding, rect: { ...binding.rect, x: 30 } }];
    const reopened = createEditor();
    reopened.loadProject(editor.toProject(), { bindings: fresh, size: { w: 300, h: 200 } });
    expect(reopened.state.boxes[0].rect.x).toBe(30);
    expect(reopened.toPayload().edits).toEqual([]);
  });

  it('resets only the in-memory workspace to a clean initial sketch', () => {
    const { editor } = iterateEditor();
    editor.setContextField('description', 'Keep this only in the saved project');
    editor.state.selectedId = editor.state.boxes[0].id;
    editor.setBoxField('note', 'pending intent');

    editor.resetProject();

    expect(editor.state).toMatchObject({
      mode: 'sketch',
      canvas: { w: 1024, h: 768 },
      boxes: [],
      selectedId: null,
      counter: 0,
      context: { description: '', style: '', background: '' },
      wireframe: null,
      interaction: { mode: 'idle' },
    });
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);
    expect(editor.toPayload()).toEqual({
      boundbox: '1',
      canvas: { w: 1024, h: 768 },
      grid: '0-1000',
      boxes: [],
    });
  });
});
