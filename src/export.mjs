/**
 * Export schema logic (boundbox.export-schema, D-001).
 *
 * Canvas-pixel rects convert to the 0–1000 normalized grid per axis at export
 * time only; internal state stays in pixels. Independent rounding may push
 * x+w past 1000, so w/h are clamped after rounding — the schema guarantees
 * x+w <= 1000 and y+h <= 1000.
 */

export function toNormalized(rect, canvas) {
  const scale = (v, span) => Math.round((v / span) * 1000);
  let x = scale(rect.x, canvas.w);
  let y = scale(rect.y, canvas.h);
  let w = scale(rect.w, canvas.w);
  let h = scale(rect.h, canvas.h);
  x = Math.min(Math.max(x, 0), 1000);
  y = Math.min(Math.max(y, 0), 1000);
  w = Math.min(Math.max(w, 0), 1000 - x);
  h = Math.min(Math.max(h, 0), 1000 - y);
  return [x, y, w, h];
}

export function buildSketchPayload(boxes, canvas, context = {}) {
  const payload = {
    boundbox: '1',
    canvas: { w: canvas.w, h: canvas.h },
    grid: '0-1000',
  };
  for (const key of ['description', 'style', 'background']) {
    if (context[key]) payload[key] = context[key];
  }
  payload.boxes = [...boxes]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((box) => {
      const entry = {
        label: box.label || `box-${box.order ?? 0}`,
        desc: box.description ?? '',
        type: box.type ?? 'obj',
        bbox: toNormalized(box.rect, canvas),
      };
      if (box.type === 'text' && box.text) entry.text = box.text;
      return entry;
    });
  return payload;
}
