import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(path.join(root, 'src', name), 'utf8');
const [template, css, alignment, speech, localSpeech, readerLayout, library, app] = await Promise.all(
  ['index.html', 'styles.css', 'alignment.js', 'speech.js', 'local-speech.js', 'reader-layout.js', 'library.js', 'app.js'].map(read),
);
const withoutExports = source => source.replace(/^export (?=(?:class|function)\s)/gm, '');
const runtime = `(() => {\n'use strict';\n${withoutExports(alignment)}\n${withoutExports(speech)}\n${withoutExports(localSpeech)}\n${withoutExports(readerLayout)}\n${withoutExports(library)}\n${app.replace(/^import .*;\r?\n/gm, '')}\n})();`;
new vm.Script(runtime, { filename: 'sufler-bundle.js' });
const html = template
  .replace('  <link rel="stylesheet" href="./styles.css">', () => `  <style>\n${css}\n  </style>`)
  .replace('  <script type="module" src="./app.js"></script>\n', '')
  .replace('</body>', () => `<script>\n${runtime.replace(/<\/script/gi, '<\\/script')}\n</script>\n</body>`);
if (/<script[^>]*\bsrc\s*=|<link[^>]*rel="stylesheet"|^import\s/m.test(html)) throw new Error('Standalone build has external runtime dependencies.');
const output = path.join(root, process.argv.includes('--pages') ? 'docs' : 'dist');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'index.html'), html);
console.log(`Standalone HTML built: ${Buffer.byteLength(html)} bytes; no external styles or scripts.`);
