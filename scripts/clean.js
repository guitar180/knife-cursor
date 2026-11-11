#!/usr/bin/env node
'use strict';

/*
 * Safe project cleanup.
 *
 * Default is a dry run: it only prints what would be removed. Pass --yes to
 * delete. `dist` and the old Forge `out` directory are kept unless --all (or
 * --dist) is given, because the packaged zip is a deliverable.
 *
 * Protected by construction: src/, assets/, scripts/, package.json,
 * package-lock.json, electron-builder.yml, all Vite configs, index.html,
 * settings.html, tsconfig.json, README.md and MATERIALS.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const apply = args.has('--yes');
const removeDist = args.has('--all') || args.has('--dist');
const finalBundle = path.join(projectRoot, 'MILESTONE_FINAL_CODE.md');

const REQUIRED_PATHS = [
  'src',
  'assets',
  'scripts',
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'vite.main.config.ts',
  'vite.preload.config.ts',
  'vite.renderer.config.ts',
  'index.html',
  'settings.html',
  'tsconfig.json',
  'README.md',
  'MATERIALS.md',
];

const protectedPaths = new Set(
  REQUIRED_PATHS.map((relativePath) => path.resolve(projectRoot, relativePath)),
);

const targets = [
  {
    relativePath: '.vite',
    description: 'Vite build output (recreated by npm run build/start)',
  },
  {
    relativePath: '.userdata',
    description: 'development userData, crash.log, dev.log and cursor helper files',
  },
  {
    relativePath: '.cursor-integration',
    description: 'cursor helper integration-test logs',
  },
  {
    relativePath: 'crash.log',
    description: 'old crash log at project root',
  },
  {
    relativePath: 'system-cursor.log',
    description: 'old cursor helper log at project root',
  },
  {
    relativePath: 'dev.log',
    description: 'old development log at project root',
  },
  {
    relativePath: 'forge-output.log',
    description: 'old Forge packaging log',
  },
  {
    relativePath: 'launcher.log',
    description: 'old launcher log',
  },
  {
    relativePath: path.join('node_modules', 'electron', 'dist', 'crash.log'),
    description: 'stale crash.log copied into the Electron distribution',
  },
  {
    relativePath: 'out',
    description: 'old Electron Forge output',
    optional: true,
  },
  {
    relativePath: 'dist',
    description: 'electron-builder output (zip/unpacked app)',
    optional: true,
    keepByDefault: true,
  },
];

const ROOT_JUNK_PATTERNS = [
  /^\.cursor-.*/,
  /^\.detached-.*/,
  /^\.terminal-close-.*/,
  /^\.capture-.*/,
  /^\.pkgtest$/,
  /^\.packaged-test$/,
  /^\.finaltest$/,
];

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function pathSize(targetPath) {
  let total = 0;

  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isDirectory()) {
      return stat.size;
    }

    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      total += pathSize(path.join(targetPath, entry.name));
    }
  } catch {
    return total;
  }

  return total;
}

function isInsideProject(targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function assertSafe(targetPath) {
  if (!isInsideProject(targetPath)) {
    throw new Error(`refusing to touch a path outside the project: ${targetPath}`);
  }
  if (targetPath === projectRoot) {
    throw new Error('refusing to delete the project root');
  }
  if (protectedPaths.has(targetPath)) {
    throw new Error(`refusing to delete protected path: ${targetPath}`);
  }
}

const planned = [];
const plannedPaths = new Set();

function plan(relativePath, description, optional = false) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath) || plannedPaths.has(absolutePath)) {
    return;
  }

  assertSafe(absolutePath);
  plannedPaths.add(absolutePath);
  planned.push({ absolutePath, description, optional });
}

for (const target of targets) {
  if (target.keepByDefault && !removeDist) {
    continue;
  }
  plan(target.relativePath, target.description, target.optional === true);
}

for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
  if (ROOT_JUNK_PATTERNS.some((pattern) => pattern.test(entry.name))) {
    plan(entry.name, 'temporary test artifact');
  }
}

const milestones = fs
  .readdirSync(projectRoot, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      /^MILESTONE.*\.md$/i.test(entry.name) &&
      entry.name !== 'MILESTONE_FINAL_CODE.md',
  );

if (milestones.length > 0 && !fs.existsSync(finalBundle)) {
  console.warn(
    'MILESTONE_FINAL_CODE.md is missing. Old milestone files will be kept so ' +
      'the final source bundle is not lost. Create the final bundle first.',
  );
} else {
  for (const entry of milestones) {
    plan(entry.name, 'superseded milestone source bundle');
  }
}

planned.sort((left, right) =>
  left.absolutePath.localeCompare(right.absolutePath),
);

if (planned.length === 0) {
  console.log('Nothing to clean.');
  process.exit(0);
}

let totalBytes = 0;

console.log(
  apply
    ? 'Cleanup plan (will delete):'
    : 'Cleanup plan (dry run; pass --yes to delete):',
);

for (const item of planned) {
  const bytes = pathSize(item.absolutePath);
  totalBytes += bytes;
  console.log(`  - ${path.relative(projectRoot, item.absolutePath)}`);
  console.log(`      ${item.description}; ${formatBytes(bytes)}`);
}

console.log(`\nTotal: ${formatBytes(totalBytes)} in ${planned.length} item(s).`);
console.log('\nAlways kept:');
for (const requiredPath of REQUIRED_PATHS) {
  console.log(`  + ${requiredPath}`);
}
if (!removeDist) {
  console.log('  + dist (packaged artifact; use --all to remove it)');
}

if (!apply) {
  console.log('\nDry run only. Review the list, then run:');
  console.log('  npm run clean:apply');
  console.log('To also remove dist:');
  console.log('  npm run clean:all');
  process.exit(0);
}

let failures = 0;
for (const item of planned) {
  try {
    fs.rmSync(item.absolutePath, { recursive: true, force: true });
    console.log(`removed ${path.relative(projectRoot, item.absolutePath)}`);
  } catch (error) {
    failures += 1;
    console.error(
      `failed to remove ${path.relative(projectRoot, item.absolutePath)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} item(s) could not be removed. Close the app and retry.`);
  process.exit(1);
}

console.log('\nCleanup complete.');