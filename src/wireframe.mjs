/**
 * Wireframe pipeline (boundbox.wireloom-integration + L2 layout-binding).
 *
 * Parses a Wireloom source with the vendored library (D-009), renders the
 * background SVG, and builds the flat LayoutBinding list that backs
 * wireframe-bound overlay boxes. Bindable-element policy per the plan:
 * leaves and titled containers become bindings; anonymous layout nodes
 * (row/col/panel/list/window) pass through; annotations are excluded.
 */
import { parse, layout, renderWireframe, DEFAULT_THEME, WireloomError } from '../vendor/wireloom.mjs';

const LEAF_KINDS = new Set([
  'text', 'button', 'input', 'combo', 'slider', 'kv', 'image', 'icon', 'divider',
  'cell', 'resource', 'stat', 'progress', 'chart', 'tab', 'item', 'tabitem',
  'backbutton', 'segment', 'checkbox', 'radio', 'toggle', 'menuitem', 'crumb',
  'chip', 'avatar', 'spinner', 'status', 'node', 'spacer',
]);
const CONTAINER_KINDS = new Set([
  'section', 'slot', 'header', 'footer', 'navbar', 'tabbar', 'sheet', 'segmented',
  'tabs', 'menubar', 'menu', 'breadcrumb', 'tree', 'grid', 'resourcebar', 'stats',
]);

const labelFor = (node) => {
  for (const key of ['title', 'text', 'label', 'content', 'value', 'placeholder', 'name']) {
    const v = node[key];
    if (typeof v === 'string' && v.length) return v;
  }
  return '';
};

export { WireloomError };

/**
 * source text -> { svg, size, bindings }. Throws WireloomError (with .line/.column)
 * on parse failure — the caller owns the error surface.
 */
export function loadWireframe(source, { theme } = {}) {
  const doc = parse(source);
  const laid = layout(doc, DEFAULT_THEME);
  const svg = renderWireframe(source, { id: 'boundbox-wireframe', ...(theme ? { theme } : {}) });

  const bindings = [];
  const walk = (laidNode, depth) => {
    const { node, x, y, width, height, children } = laidNode;
    if (node?.kind && width > 0 && height > 0
      && (LEAF_KINDS.has(node.kind) || CONTAINER_KINDS.has(node.kind))) {
      bindings.push({
        line: node.position?.line ?? 0,
        column: node.position?.column ?? 0,
        kind: node.kind,
        label: labelFor(node),
        rect: { x, y, w: width, h: height },
        depth,
      });
    }
    for (const child of children ?? []) walk(child, depth + 1);
  };
  walk(laid.root, 0);

  return {
    svg,
    size: { w: Math.ceil(laid.canvasWidth), h: Math.ceil(laid.canvasHeight) },
    bindings,
  };
}
