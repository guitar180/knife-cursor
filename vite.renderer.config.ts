import path from 'node:path';
import { defineConfig } from 'vite';

// Both HTML entry points share one renderer build so main.ts can load them
// from .vite/renderer/main_window in production. The dev server serves them
// directly from the project root.
export default defineConfig({
  root: __dirname,
  base: './',
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        settings: path.resolve(__dirname, 'settings.html'),
      },
    },
  },
  server: {
    watch: {
      ignored: [
        '**/.userdata/**',
        '**/diag/**',
        '**/dist/**',
        '**/out/**',
        '**/.vite/**',
        // Atomic-save/editor temp directories can disappear while chokidar
        // is attaching a watcher, which crashes Vite with EBUSY on Windows.
        '**/.*.tmpdir/**',
      ],
    },
  },
});