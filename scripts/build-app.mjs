/**
 * Bundle src/app.mjs into the single-file app (D-006/D-007).
 * app/template.html + bundled JS -> app/boundbox.html
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const result = await build({
  entryPoints: [join(root, 'src', 'app.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});
if (result.errors.length) {
  console.error(result.errors);
  process.exit(1);
}
const js = result.outputFiles[0].text
  .replaceAll('</script', '<\\/script'); // keep the inline bundle from closing its own tag

const template = readFileSync(join(root, 'app', 'template.html'), 'utf8');
if (!template.includes('<!--APP_JS-->')) {
  console.error('template.html is missing the <!--APP_JS--> placeholder');
  process.exit(1);
}
const html = template
  .replace('<!--APP_JS-->', () => js)
  .replace('<title>BoundBox</title>', `<title>BoundBox</title>\n<!-- boundbox v${version} — built by scripts/build-app.mjs; edit src/ + app/template.html, not this file -->`);

writeFileSync(join(root, 'app', 'boundbox.html'), html, 'utf8');
console.log(`OK app/boundbox.html (${html.length} bytes, v${version})`);
