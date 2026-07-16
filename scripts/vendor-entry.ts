/**
 * Vendor entry for Wireloom internals (D-009).
 *
 * Bundled by scripts/vendor-wireloom.mjs straight from the Wireloom repo's
 * TypeScript source — this is what gives BoundBox access to layout() (per-element
 * rects + AST source positions), which Wireloom's public npm API does not expose.
 *
 * Wireloom is MIT © 2026 Brad Wardell (https://github.com/StardockCorp/Wireloom).
 */
export { parse } from '../../Wireloom/src/parser/parser.js';
export { serialize } from '../../Wireloom/src/parser/serializer.js';
export { WireloomError } from '../../Wireloom/src/parser/errors.js';
export { layout } from '../../Wireloom/src/renderer/layout.js';
export type { LaidDocument, LaidOutNode } from '../../Wireloom/src/renderer/layout.js';
export { renderWireframe } from '../../Wireloom/src/renderer/index.js';
export { DEFAULT_THEME, DARK_THEME } from '../../Wireloom/src/renderer/themes.js';
