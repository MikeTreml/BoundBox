/**
 * Iterate-profile packet builder (boundbox.edit-deltas, D-005/D-008).
 *
 * Edits are DERIVED by diffing the current overlay state against the layout
 * bindings rather than replaying an event log: merge rules (move+move
 * collapse, delete supersedes, add absorbs its edits) fall out for free, and
 * the overlay-only undo stack (D-011) covers edits with no extra machinery.
 * D-005 holds structurally — bound boxes are rebuilt from bindings on every
 * accepted source version, so stale diffs cannot exist.
 */
import { toNormalized } from './export.mjs';

const targetOf = (box) => ({
  line: box.binding.line,
  kind: box.binding.kind,
  label: box.binding.label || box.binding.kind,
});

/** Diff one bound box against its binding -> zero or more edits. */
export function editsForBox(box, canvas) {
  const edits = [];
  if (box.deleted) {
    edits.push({ op: 'delete', target: targetOf(box) });
    return edits; // delete supersedes geometry and notes
  }
  const from = box.binding.rect;
  const to = box.rect;
  const moved = Math.round(to.x) !== Math.round(from.x) || Math.round(to.y) !== Math.round(from.y);
  const resized = Math.round(to.w) !== Math.round(from.w) || Math.round(to.h) !== Math.round(from.h);
  if (moved || resized) {
    const bbox = toNormalized(to, canvas);
    edits.push({
      op: moved && resized ? 'move' : (moved ? 'move' : 'resize'),
      target: targetOf(box),
      to: moved && resized
        ? { x: bbox[0], y: bbox[1], w: bbox[2], h: bbox[3] }
        : (moved ? { x: bbox[0], y: bbox[1] } : { w: bbox[2], h: bbox[3] }),
    });
  }
  if (box.note?.trim()) {
    edits.push({ op: 'annotate', target: targetOf(box), note: box.note.trim() });
  }
  return edits;
}

export function buildIteratePayload({ boxes, canvas, context, sourceText, sourceVersion }) {
  const edits = [];
  for (const box of boxes) {
    if (box.origin === 'wireframe-bound') {
      edits.push(...editsForBox(box, canvas));
    } else {
      const entry = {
        op: 'add',
        label: box.label,
        desc: box.description ?? '',
        bbox: toNormalized(box.rect, canvas),
      };
      if (box.type === 'text' && box.text) entry.text = box.text;
      edits.push(entry);
    }
  }
  const payload = {
    boundbox: '1',
    profile: 'iterate',
    canvas: { w: canvas.w, h: canvas.h },
    grid: '0-1000',
    source_version: sourceVersion,
    wireframe_source: sourceText,
    edits,
  };
  for (const key of ['description', 'style', 'background']) {
    if (context?.[key]) payload[key] = context[key];
  }
  return payload;
}

/** True when the overlay carries any pending edit relative to the bindings. */
export const hasPendingEdits = (boxes, canvas) => boxes.some((box) => (
  box.origin === 'wireframe-bound' ? editsForBox(box, canvas).length > 0 : true
));
