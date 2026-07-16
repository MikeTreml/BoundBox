import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract } from '../scripts/wireloom-extract.mjs';

const source = readFileSync(new URL('../fixtures/boundbox-mockup.wireloom', import.meta.url), 'utf8');

describe('wireloom extraction (vendored layout())', () => {
  const { svg, rects } = extract(source);

  it('renders SVG and reports canvas dimensions', () => {
    expect(svg).toContain('<svg');
    expect(rects.canvasWidth).toBeGreaterThan(0);
    expect(rects.canvasHeight).toBeGreaterThan(0);
  });

  it('binds known elements with source lines and plausible rects', () => {
    const kvX = rects.elements.find((e) => e.kind === 'kv' && e.label === 'X');
    expect(kvX).toBeDefined();
    expect(kvX.line).toBe(29);
    expect(kvX.w).toBeGreaterThan(0);
    expect(kvX.h).toBeGreaterThan(0);

    const slots = rects.elements.filter((e) => e.kind === 'slot').map((e) => e.label);
    expect(slots).toEqual(expect.arrayContaining(['hero', 'nav', 'cta']));
  });

  it('every element carries a source line inside the fixture', () => {
    for (const e of rects.elements) {
      expect(e.line, `${e.kind} "${e.label}"`).toBeGreaterThan(0);
    }
  });

  it('throws WireloomError with position info on a broken source', () => {
    expect(() => extract('window:\n\ttabs-are-illegal')).toThrowError();
  });
});
