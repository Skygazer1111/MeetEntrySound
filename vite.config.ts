import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Builds the React UI (popup + options page) and copies /public (manifest, icons) to dist.
// The content scripts and service worker are built separately as self-contained IIFE
// bundles by scripts/build-scripts.mjs (see the note there on why).
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        options: resolve(__dirname, 'options.html'),
      },
    },
  },
});
