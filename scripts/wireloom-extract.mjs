/**
 * Headless Wireloom extraction: source.wireloom -> rendered SVG + per-element rects.
 *
 *   node scripts/wireloom-extract.mjs <input.wireloom> [outBase]
 *
 * Writes <outBase>.svg and <outBase>.rects.json (default outBase = input path
 * minus extension). The rects JSON is the fixture format for layout-binding
 * tests: a flat walk of the laid-out tree with AST source positions.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, layout, renderWireframe, DEFAULT_THEME, WireloomError } from '../vendor/wireloom.mjs';

export function extract(source) {
  const doc = parse(source);
  const laid = layout(doc, DEFAULT_THEME);
  const svg = renderWireframe(source, { id: 'boundbox-extract' });

  const rects = [];
  const walk = (laidNode, depth) => {
    const { node, x, y, width, height, children } = laidNode;
    if (node && node.kind) {
      rects.push({
        line: node.position?.line ?? null,
        column: node.position?.column ?? null,
        kind: node.kind,
        label: labelFor(node),
        x, y, w: width, h: height,
        depth,
      });
    }
    for (const child of children ?? []) walk(child, depth + 1);
  };
  walk(laid.root, 0);

  return {
    svg,
    rects: {
      canvasWidth: laid.canvasWidth,
      canvasHeight: laid.canvasHeight,
      elements: rects,
    },
  };
}

function labelFor(node) {
  for (const key of ['title', 'text', 'label', 'content', 'value', 'placeholder', 'name']) {
    const v = node[key];
    if (typeof v === 'string' && v.length) return v;
  }
  return '';
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const [, , inPath, outBaseArg] = process.argv;
  if (!inPath) {
    console.error('usage: node scripts/wireloom-extract.mjs <input.wireloom> [outBase]');
    process.exit(2);
  }
  const outBase = outBaseArg ?? inPath.replace(/\.wireloom$/, '');
  try {
    const { svg, rects } = extract(readFileSync(inPath, 'utf8'));
    writeFileSync(`${outBase}.svg`, svg, 'utf8');
    writeFileSync(`${outBase}.rects.json`, JSON.stringify(rects, null, 2), 'utf8');
    console.log(`OK ${outBase}.svg (${svg.length} bytes), ${outBase}.rects.json (${rects.elements.length} elements)`);
  } catch (err) {
    if (err instanceof WireloomError) {
      console.error(`PARSE FAIL line ${err.line}, col ${err.column}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
