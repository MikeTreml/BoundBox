import { describe, it, expect } from 'vitest';
import { toNormalized, buildSketchPayload } from '../src/export.mjs';

const CANVAS = { w: 1024, h: 768 };

describe('toNormalized', () => {
  it('matches the plan fixture: (40,120,880,320) on 1024x768 -> [39,156,859,417]', () => {
    expect(toNormalized({ x: 40, y: 120, w: 880, h: 320 }, CANVAS)).toEqual([39, 156, 859, 417]);
  });

  it('guarantees x+w <= 1000 and y+h <= 1000 across a sweep of edge-clamped rects', () => {
    for (let x = 0; x <= 1024; x += 64) {
      for (let w = 0; w <= 1024 - x; w += 64) {
        const [nx, , nw] = toNormalized({ x, y: 0, w, h: 768 }, CANVAS);
        expect(nx + nw).toBeLessThanOrEqual(1000);
      }
    }
    const [, ny, , nh] = toNormalized({ x: 0, y: 767, w: 1, h: 1 }, CANVAS);
    expect(ny + nh).toBeLessThanOrEqual(1000);
  });

  it('full-canvas box maps to [0,0,1000,1000]', () => {
    expect(toNormalized({ x: 0, y: 0, w: 1024, h: 768 }, CANVAS)).toEqual([0, 0, 1000, 1000]);
  });
});

describe('buildSketchPayload', () => {
  it('exports boxes in order, includes text for text-type, omits empty context', () => {
    const payload = buildSketchPayload(
      [
        { order: 2, label: 'cta', description: 'Sign-up button', type: 'text', text: 'Sign up free', rect: { x: 0, y: 0, w: 100, h: 50 } },
        { order: 1, label: 'hero', description: 'Hero banner', type: 'obj', rect: { x: 40, y: 120, w: 880, h: 320 } },
      ],
      CANVAS,
      { description: 'landing page', style: '' },
    );
    expect(payload.boxes.map((b) => b.label)).toEqual(['hero', 'cta']);
    expect(payload.boxes[1].text).toBe('Sign up free');
    expect(payload.boxes[0].text).toBeUndefined();
    expect(payload.description).toBe('landing page');
    expect(payload.style).toBeUndefined();
    expect(payload.boxes[0].bbox).toEqual([39, 156, 859, 417]);
  });

  it('empty canvas exports a valid payload; text type with empty text omits the field (review: test gaps)', () => {
    const empty = buildSketchPayload([], CANVAS, {});
    expect(empty.boxes).toEqual([]);
    expect(empty.boundbox).toBe('1');

    const payload = buildSketchPayload(
      [{ order: 0, label: 'cta', description: '', type: 'text', text: '', rect: { x: 0, y: 0, w: 100, h: 50 } }],
      CANVAS,
      {},
    );
    expect('text' in payload.boxes[0]).toBe(false);
    expect(payload.boxes[0].type).toBe('text');
  });
});
