#!/usr/bin/env node
'use strict';

/*
 * Production build without Electron Forge.
 *
 * Outputs:
 *   .vite/build/main.js       main process
 *   .vite/build/preload.js    shared preload
 *   .vite/renderer/main_window/index.html
 *   .vite/renderer/main_window/settings.html
 */

const fs = require('node:fs');
const path = require('node:path');
const { build } = require('vite');

const projectRoot = path.resolve(__dirname, '..');
const viteDir = path.join(projectRoot, '.vite');

async function runBuild(configFile) {
  console.log(`[build] ${configFile}`);
  await build({
    root: projectRoot,
    configFile: path.join(projectRoot, configFile),
    mode: 'production',
  });
}

function requireFile(relativePath, minBytes = 1) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`missing build output: ${relativePath}`);
  }

  const size = fs.statSync(absolutePath).size;
  if (size < minBytes) {
    throw new Error(`build output is empty: ${relativePath}`);
  }

  console.log(`[build] ${relativePath} (${size} bytes)`);
}

async function main() {
  fs.rmSync(viteDir, { recursive: true, force: true });

  await runBuild('vite.main.config.ts');
  await runBuild('vite.preload.config.ts');
  await runBuild('vite.renderer.config.ts');

  requireFile('.vite/build/main.js', 1000);
  requireFile('.vite/build/preload.js', 1000);
  requireFile('.vite/renderer/main_window/index.html', 100);
  requireFile('.vite/renderer/main_window/settings.html', 100);

  console.log('[build] complete');
}

main().catch((error) => {
  console.error('[build] failed', error);
  process.exit(1);
});