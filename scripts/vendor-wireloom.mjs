import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, 'vendor-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: join(here, '..', 'vendor', 'wireloom.mjs'),
  banner: {
    js: '// Vendored from https://github.com/StardockCorp/Wireloom (MIT © 2026 Brad Wardell). Do not edit; regenerate with `npm run vendor`.',
  },
  logLevel: 'info',
});

if (result.errors.length) process.exit(1);
