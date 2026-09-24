import { describe, it, expect } from 'vitest';
import { createEditor } from '../src/editor.mjs';

const draw = (ed, from, to) => {
  ed.pointerDown(from);
  ed.pointerMove(to);
  return ed.pointerUp(to);
};

describe('editor pointer state machine', () => {
  it('draw-commit creates, clamps, selects, auto-labels, and asks to focus description', () => {
    const ed = createEditor();
    const effect = draw(ed, { x: 40, y: 120 }, { x: 920, y: 440 });
    expect(effect).toBe('focus-description');
    expect(ed.state.boxes).toHaveLength(1);
    expect(ed.state.boxes[0].label).toBe('box-1');
    expect(ed.state.boxes[0].rect).toEqual({ x: 40, y: 120, w: 880, h: 320 });
    expect(ed.state.selectedId).toBe(ed.state.boxes[0].id);
    expect(ed.state.interaction.mode).toBe('idle');
  });

  it('draw below min size cancels; sub-threshold click is not a drag', () => {
    const ed = createEditor();
    draw(ed, { x: 10, y: 10 }, { x: 14, y: 14 }); // 4px < MIN_SIZE
    expect(ed.state.boxes).toHaveLength(0);

    draw(ed, { x: 10, y: 10 }, { x: 11, y: 11 }); // below drag threshold entirely
    expect(ed.state.boxes).toHaveLength(0);
    expect(ed.state.interaction.mode).toBe('idle');
  });

  it('drag moves with canvas clamping; escape mid-drag restores the original rect', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    const box = ed.state.boxes[0];

    ed.pointerDown({ x: 150, y: 150 });
    ed.pointerMove({ x: 5000, y: 150 }); // way past the right edge
    expect(box.rect.x + box.rect.w).toBeLessThanOrEqual(ed.state.canvas.w);
    ed.escape();
    expect(box.rect).toEqual({ x: 100, y: 100, w: 100, h: 100 });
    expect(ed.state.interaction.mode).toBe('idle');
  });

  it('resize via se handle grows the box; inversion via nw past the far edge normalizes', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    const box = ed.state.boxes[0];

    ed.pointerDown({ x: 200, y: 200 }); // se handle
    ed.pointerMove({ x: 260, y: 240 });
    ed.pointerUp({ x: 260, y: 240 });
    expect(box.rect).toEqual({ x: 100, y: 100, w: 160, h: 140 });

    ed.pointerDown({ x: 100, y: 100 }); // nw handle
    ed.pointerMove({ x: 300, y: 300 }); // dragged past the se corner — inverts
    ed.pointerUp({ x: 300, y: 300 });
    expect(box.rect.w).toBeGreaterThan(0);
    expect(box.rect.h).toBeGreaterThan(0);
    expect(box.rect.x).toBeGreaterThanOrEqual(260 - box.rect.w); // normalized, not negative
  });

  it('click empty deselects; repeated clicks cycle overlapping boxes', () => {
    const ed = createEditor();
    draw(ed, { x: 50, y: 50 }, { x: 200, y: 200 });
    // Second draw STARTS on empty canvas (outside box A) but overlaps it.
    draw(ed, { x: 150, y: 250 }, { x: 250, y: 150 });
    const [bottom, top] = ed.state.boxes;
    expect(ed.state.boxes).toHaveLength(2);

    const click = (p) => { ed.pointerDown(p); ed.pointerUp(p); };
    click({ x: 175, y: 175 }); // overlap region: topmost first
    expect(ed.state.selectedId).toBe(top.id);
    click({ x: 176, y: 175 }); // within tolerance: cycles beneath
    expect(ed.state.selectedId).toBe(bottom.id);
    click({ x: 175, y: 176 }); // cycles back around
    expect(ed.state.selectedId).toBe(top.id);

    click({ x: 900, y: 700 }); // empty canvas
    expect(ed.state.selectedId).toBeNull();
  });

  it('labels never reuse numbers after deletion (box-1..3, delete 2, next is box-4)', () => {
    const ed = createEditor();
    draw(ed, { x: 10, y: 10 }, { x: 60, y: 60 });
    draw(ed, { x: 110, y: 10 }, { x: 160, y: 60 });
    draw(ed, { x: 210, y: 10 }, { x: 260, y: 60 });
    ed.state.selectedId = ed.state.boxes[1].id; // box-2
    ed.deleteSelection();
    draw(ed, { x: 310, y: 10 }, { x: 360, y: 60 });
    expect(ed.state.boxes.map((b) => b.label)).toEqual(['box-1', 'box-3', 'box-4']);
    expect(ed.state.boxes.map((b) => b.order)).toEqual([0, 1, 2]);
  });

  it('undo/redo round-trips create, move, and delete (D-011 overlay-only stack)', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    ed.pointerDown({ x: 150, y: 150 });
    ed.pointerMove({ x: 250, y: 150 });
    ed.pointerUp({ x: 250, y: 150 }); // moved +100 x
    expect(ed.state.boxes[0].rect.x).toBe(200);

    ed.undo(); // move undone
    expect(ed.state.boxes[0].rect.x).toBe(100);
    ed.undo(); // create undone
    expect(ed.state.boxes).toHaveLength(0);
    ed.redo();
    expect(ed.state.boxes).toHaveLength(1);
    ed.redo();
    expect(ed.state.boxes[0].rect.x).toBe(200);

    ed.state.selectedId = null;
    ed.deleteSelection(); // no selection -> no-op
    expect(ed.state.boxes).toHaveLength(1);
    ed.state.selectedId = ed.state.boxes[0].id;
    ed.deleteSelection();
    expect(ed.state.boxes).toHaveLength(0);
    ed.undo();
    expect(ed.state.boxes).toHaveLength(1);
  });

  it('property edits validate: bad numbers rejected, empty label reverts, rects clamp', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });

    expect(ed.setBoxField('x', 'abc')).toBe(false);
    expect(ed.state.boxes[0].rect.x).toBe(100);
    expect(ed.setBoxField('x', '5000')).toBe(true); // clamps into canvas
    expect(ed.state.boxes[0].rect.x + ed.state.boxes[0].rect.w).toBeLessThanOrEqual(1024);

    expect(ed.setBoxField('label', '   ')).toBe(false); // empty reverts
    expect(ed.setBoxField('label', 'hero\nbanner')).toBe(true); // newlines stripped
    expect(ed.state.boxes[0].label).toBe('hero banner');
    expect(ed.setBoxField('type', 'text')).toBe(true);
    expect(ed.setBoxField('text', 'Sign up free')).toBe(true);
  });

  it('canvas resize clamps existing boxes and is undoable', () => {
    const ed = createEditor();
    draw(ed, { x: 900, y: 600 }, { x: 1020, y: 760 });
    expect(ed.setCanvasSize(800, 600)).toBe(true);
    const { rect } = ed.state.boxes[0];
    expect(rect.x + rect.w).toBeLessThanOrEqual(800);
    expect(rect.y + rect.h).toBeLessThanOrEqual(600);
    ed.undo();
    expect(ed.state.canvas).toEqual({ w: 1024, h: 768 });
  });

  it('resize past the far canvas edge pins the anchored edge (review: anchor-break)', () => {
    const ed = createEditor();
    draw(ed, { x: 900, y: 100 }, { x: 1000, y: 200 }); // box {900,100,100,100}
    ed.pointerDown({ x: 900, y: 150 }); // west handle
    ed.pointerMove({ x: 1100, y: 150 }); // pointer far past the right canvas edge
    ed.pointerUp({ x: 1100, y: 150 });
    // Anchor (east edge at 1000) must not move; pointer clamps to 1024.
    expect(ed.state.boxes[0].rect).toEqual({ x: 1000, y: 100, w: 24, h: 100 });
  });

  it('drawing past the canvas edge keeps the start-point anchor (review: anchor-break)', () => {
    const ed = createEditor();
    draw(ed, { x: 1000, y: 100 }, { x: 1100, y: 150 });
    expect(ed.state.boxes[0].rect).toEqual({ x: 1000, y: 100, w: 24, h: 50 });
  });

  it('rejects empty/whitespace numeric input instead of treating it as 0 (review)', () => {
    const ed = createEditor();
    draw(ed, { x: 400, y: 300 }, { x: 600, y: 450 });
    expect(ed.setBoxField('w', '')).toBe(false);
    expect(ed.setBoxField('w', '   ')).toBe(false);
    expect(ed.state.boxes[0].rect.w).toBe(200);
    expect(ed.setCanvasSize('', 600)).toBe(false);
    expect(ed.state.canvas.w).toBe(1024);
  });

  it('gates delete/undo/redo while a gesture is active (review)', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    ed.pointerDown({ x: 150, y: 150 });
    ed.pointerMove({ x: 300, y: 150 }); // dragging
    expect(ed.deleteSelection()).toBe(false);
    expect(ed.undo()).toBe(false);
    expect(ed.state.boxes).toHaveLength(1);
    ed.pointerUp({ x: 300, y: 150 });
    expect(ed.deleteSelection()).toBe(true);
  });

  it('undo baseline for a drag includes field edits committed by the same press (review: stale snapshot)', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    ed.setBoxField('description', 'old');

    // Browser order: press on the box, THEN the blur commits the pending edit,
    // THEN the drag crosses the threshold.
    ed.pointerDown({ x: 150, y: 150 });
    ed.setBoxField('description', 'new'); // blur-committed mid-press
    ed.pointerMove({ x: 250, y: 150 });
    ed.pointerUp({ x: 250, y: 150 });

    expect(ed.undo()).toBe(true); // undo the move only
    expect(ed.state.boxes[0].rect.x).toBe(100);
    expect(ed.state.boxes[0].description).toBe('new'); // the committed edit survives
    expect(ed.undo()).toBe(true); // now undo the description edit
    expect(ed.state.boxes[0].description).toBe('old');
  });

  it('no-op edits push no undo entries (review: stack pollution)', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    ed.setBoxField('label', 'hero');
    expect(ed.setBoxField('label', ' hero ')).toBe(true); // trims to identical
    expect(ed.setBoxField('x', '100')).toBe(true); // unchanged rect
    expect(ed.setContextField('style', '')).toBe(true); // already empty
    ed.undo();
    expect(ed.state.boxes[0].label).toBe('box-1'); // single entry for the label set
  });

  it('cycling resets on a fresh click point and after drags (review)', () => {
    const ed = createEditor();
    draw(ed, { x: 50, y: 50 }, { x: 200, y: 200 });
    draw(ed, { x: 150, y: 250 }, { x: 250, y: 150 });
    const [bottom, top] = ed.state.boxes;
    const click = (p) => { ed.pointerDown(p); ed.pointerUp(p); };

    click({ x: 175, y: 175 });
    click({ x: 175, y: 175 }); // cycle down
    expect(ed.state.selectedId).toBe(bottom.id);
    click({ x: 185, y: 185 }); // >2px away: fresh click selects topmost again
    expect(ed.state.selectedId).toBe(top.id);

    // Press-drag from the overlap point moves the SELECTED (top) box, not the one beneath...
    ed.pointerDown({ x: 175, y: 175 });
    ed.pointerMove({ x: 175, y: 185 });
    ed.pointerUp({ x: 175, y: 185 });
    expect(ed.state.selectedId).toBe(top.id);
    // ...and the drag does not count as a click for cycling.
    click({ x: 175, y: 185 });
    expect(ed.state.selectedId).toBe(top.id);
  });

  it('movement carried only in the pointerup event is applied (review)', () => {
    const ed = createEditor();
    ed.pointerDown({ x: 100, y: 100 });
    ed.pointerMove({ x: 150, y: 140 });
    ed.pointerUp({ x: 160, y: 150 });
    expect(ed.state.boxes[0].rect).toEqual({ x: 100, y: 100, w: 60, h: 50 });
  });

  it('escape cancels mid-draw and mid-resize exactly (review: test gap)', () => {
    const ed = createEditor();
    ed.pointerDown({ x: 100, y: 100 });
    ed.pointerMove({ x: 180, y: 180 }); // drawing
    ed.escape();
    ed.pointerUp({ x: 180, y: 180 });
    expect(ed.state.boxes).toHaveLength(0);
    expect(ed.undo()).toBe(false); // no phantom entry

    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    ed.pointerDown({ x: 200, y: 200 }); // se handle
    ed.pointerMove({ x: 300, y: 300 });
    ed.escape();
    expect(ed.state.boxes[0].rect).toEqual({ x: 100, y: 100, w: 100, h: 100 });
    expect(ed.state.interaction.mode).toBe('idle');
  });

  it('labels truncate to 40 chars; canvas below 64 rejected without phantom undo (review: test gaps)', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    ed.setBoxField('label', 'x'.repeat(60));
    expect(ed.state.boxes[0].label).toHaveLength(40);

    expect(ed.setCanvasSize(63, 600)).toBe(false);
    expect(ed.setCanvasSize('abc', 600)).toBe(false);
    expect(ed.setCanvasSize(Number.MAX_SAFE_INTEGER + 1, 600)).toBe(false);
    expect(ed.state.canvas).toEqual({ w: 1024, h: 768 });
    ed.undo(); // label edit
    ed.undo(); // create
    expect(ed.state.boxes).toHaveLength(0);
    expect(ed.undo()).toBe(false); // nothing else was pushed
  });

  it('undo caps at 100 entries; redo clears on new action (review: test gaps)', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    for (let i = 0; i < 105; i++) ed.setBoxField('description', `d${i}`);
    let undos = 0;
    while (ed.undo()) undos += 1;
    expect(undos).toBe(100); // bounded stack; oldest states dropped
    expect(ed.state.boxes).toHaveLength(1); // the create fell off the stack

    while (ed.redo()) { /* rewind fully */ }
    ed.setBoxField('description', 'branch'); // new action must clear redo
    ed.undo();
    expect(ed.redo()).toBe(true); // one redo (the branch)...
    expect(ed.redo()).toBe(false); // ...and nothing stale beyond it
  });

  it('payload round-trip includes context fields and ordered boxes', () => {
    const ed = createEditor();
    draw(ed, { x: 40, y: 120 }, { x: 920, y: 440 });
    ed.setBoxField('label', 'hero');
    ed.setBoxField('description', 'Hero banner image');
    ed.setContextField('description', 'landing page for BoundBox');

    const payload = ed.toPayload();
    expect(payload.description).toBe('landing page for BoundBox');
    expect(payload.boxes[0]).toMatchObject({ label: 'hero', desc: 'Hero banner image', bbox: [39, 156, 859, 417] });
  });

  it('moveBox reorders export order and is undoable', () => {
    const ed = createEditor();
    draw(ed, { x: 10, y: 10 }, { x: 80, y: 80 });
    draw(ed, { x: 90, y: 90 }, { x: 160, y: 160 });
    ed.state.selectedId = ed.state.boxes[0].id;
    ed.setBoxField('label', 'first');
    ed.state.selectedId = ed.state.boxes[1].id;
    ed.setBoxField('label', 'second');
    expect(ed.moveBox(ed.state.boxes[1].id, -1)).toBe(true);
    expect(ed.toPayload().boxes.map((box) => box.label)).toEqual(['second', 'first']);
    ed.undo();
    expect(ed.toPayload().boxes.map((box) => box.label)).toEqual(['first', 'second']);
    expect(ed.moveBox(ed.state.boxes[0].id, -1)).toBe(false);
  });

  it('select tool does not draw; grid lock snaps to a settable step', () => {
    const ed = createEditor();
    ed.setTool('select');
    draw(ed, { x: 10, y: 10 }, { x: 80, y: 80 });
    expect(ed.state.boxes).toHaveLength(0);

    ed.setTool('draw');
    expect(ed.setGridStep(0)).toBe(false);
    expect(ed.setGridStep(50)).toBe(true);
    ed.setGridLock(true);
    draw(ed, { x: 12, y: 12 }, { x: 80, y: 90 });
    const box = ed.state.boxes[0];
    expect(box.rect.x % 50).toBe(0);
    expect(box.rect.y % 50).toBe(0);
    expect(box.rect.w % 50).toBe(0);
    expect(box.rect.h % 50).toBe(0);
  });

  it('nudge and duplicate work; duplicate refuses bound boxes', () => {
    const ed = createEditor();
    draw(ed, { x: 100, y: 100 }, { x: 200, y: 200 });
    expect(ed.nudge(1, 0)).toBe(true);
    expect(ed.state.boxes[0].rect.x).toBe(101);
    expect(ed.duplicateSelection()).toBe(true);
    expect(ed.state.boxes).toHaveLength(2);
    expect(ed.state.boxes[1].rect).toEqual({ x: 117, y: 116, w: 100, h: 100 });
  });
});
