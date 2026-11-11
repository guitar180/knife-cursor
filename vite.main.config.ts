import { builtinModules } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

// Native packages stay as runtime require() calls. electron-builder unpacks
// them from app.asar; bundling them here would break the .node loading path.
const nativeExternals = ['uiohook-napi', 'node-gyp-build'];

export default defineConfig({
  build: {
    outDir: path.resolve(__dirname, '.vite/build'),
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [
        'electron',
        'electron/main',
        'electron/common',
        'electron/renderer',
        ...nodeBuiltins,
        ...nativeExternals,
      ],
    },
  },
});