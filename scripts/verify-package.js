#!/usr/bin/env node
'use strict';

/*
 * Verify the electron-builder --dir output before zipping/distributing.
 * The native hook is useless if uiohook-napi's .node file stayed inside
 * app.asar or was omitted by the files allowlist.
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const resources = path.join(projectRoot, 'dist', 'win-unpacked', 'resources');
const appAsar = path.join(resources, 'app.asar');
const nativeBinding = path.join(
  resources,
  'app.asar.unpacked',
  'node_modules',
  'uiohook-napi',
  'prebuilds',
  'win32-x64',
  'node.napi.node',
);
const nodeGypBuild = path.join(
  resources,
  'app.asar.unpacked',
  'node_modules',
  'node-gyp-build',
);

function requirePath(target, kind) {
  if (!fs.existsSync(target)) {
    throw new Error(`missing ${kind}: ${target}`);
  }

  const stats = fs.statSync(target);
  if (kind === 'file' && stats.size === 0) {
    throw new Error(`empty file: ${target}`);
  }

  console.log(`[verify] ${kind}: ${target} (${stats.isFile() ? stats.size : 'dir'})`);
}

function main() {
  requirePath(appAsar, 'file');
  requirePath(nativeBinding, 'file');
  requirePath(nodeGypBuild, 'dir');

  const size = fs.statSync(nativeBinding).size;
  if (size < 100_000) {
    throw new Error(
      `native binding is unexpectedly small (${size} bytes); ` +
        'check the x64 prebuild and electron-builder asarUnpack',
    );
  }

  console.log('[verify] native hook unpacked correctly');
}

try {
  main();
} catch (error) {
  console.error(`[verify] failed: ${error.message}`);
  process.exit(1);
}