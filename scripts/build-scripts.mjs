// Builds the extension's non-UI scripts as standalone IIFE bundles.
//
// Why not let the UI build handle them?
//  - injected.js runs in Google Meet's MAIN world at document_start. It must be a single,
//    synchronous classic script. A bundler "loader stub" that dynamic-imports a chunk would run
//    AFTER Meet created its RTCPeerConnections and we would miss them.
//  - content.js is a classic content script (no ES module support in content_scripts).
//  - serviceWorker.js is bundled the same way for simplicity (classic service worker).
import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const entries = [
  { name: 'injected', entry: 'src/injection/index.ts' },
  { name: 'content', entry: 'src/content/index.ts' },
  { name: 'serviceWorker', entry: 'src/background/serviceWorker.ts' },
];

for (const { name, entry } of entries) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    resolve: { alias: { '@': resolve(root, 'src') } },
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'chrome110',
      minify: false, // readable bundles keep Chrome Web Store review simple
      sourcemap: false,
      watch: watch ? {} : null,
      lib: {
        entry: resolve(root, entry),
        name: `MeetEntry_${name}`,
        formats: ['iife'],
        fileName: () => `${name}.js`,
      },
    },
  });
  console.log(`built dist/${name}.js`);
}
