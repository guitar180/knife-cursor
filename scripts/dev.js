#!/usr/bin/env node
'use strict';

/*
 * Development launcher without Electron Forge.
 *
 * - Builds main/preload once with Vite.
 * - Starts the Vite renderer dev server (HMR for renderer/settings CSS/TS).
 * - Starts Electron with the dev server URL in KNIFE_CURSOR_DEV_SERVER_URL.
 *
 * Restart this command after changing src/main.ts or src/preload.ts; Vite
 * rebuilds them here, but Electron must be restarted to load new main code.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, createServer } = require('vite');

const projectRoot = path.resolve(__dirname, '..');

function ensureWritableDirectory(preferred) {
  const candidates = [
    preferred,
    path.join(projectRoot, '.userdata'),
    path.join(os.tmpdir(), 'knife-cursor-dev'),
  ];

  for (const candidate of new Set(candidates)) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(
        candidate,
        `.write-probe-${process.pid}-${Date.now()}`,
      );
      fs.writeFileSync(probe, 'probe');
      fs.unlinkSync(probe);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return path.join(os.tmpdir(), 'knife-cursor-dev');
}

const userDataDir = ensureWritableDirectory(
  process.env.KNIFE_CURSOR_USER_DATA || path.join(projectRoot, '.userdata'),
);
const logPath = path.join(userDataDir, 'dev.log');

try {
  fs.writeFileSync(logPath, '', 'utf8');
} catch {
  // Logging must not stop development.
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // Ignore.
  }
}

function appendOutput(streamName, chunk) {
  try {
    fs.appendFileSync(
      logPath,
      `\n--- ${streamName} ${new Date().toISOString()} ---\n${chunk}`,
      'utf8',
    );
  } catch {
    // Ignore.
  }
}

async function buildMainProcess() {
  fs.rmSync(path.join(projectRoot, '.vite', 'build'), {
    recursive: true,
    force: true,
  });

  for (const configFile of ['vite.main.config.ts', 'vite.preload.config.ts']) {
    log(`[dev] building ${configFile}`);
    await build({
      root: projectRoot,
      configFile: path.join(projectRoot, configFile),
      mode: 'development',
    });
  }
}

async function main() {
  const inheritedRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.KNIFE_CURSOR_USER_DATA = userDataDir;
  // Do not write crash.log into node_modules/electron/dist; electron-builder
  // copies that directory and would otherwise ship a stale development log.
  env.KNIFE_CURSOR_CRASH_DIR = userDataDir;
  env.ELECTRON_ENABLE_LOGGING = '1';

  log(
    `[dev] cwd=${projectRoot} userData=${userDataDir} ` +
      `inheritedRunAsNode=${inheritedRunAsNode ?? '(unset)'}`,
  );

  await buildMainProcess();

  const server = await createServer({
    root: projectRoot,
    configFile: path.join(projectRoot, 'vite.renderer.config.ts'),
    mode: 'development',
  });
  await server.listen();
  server.printUrls();

  const devServerUrl = server.resolvedUrls?.local?.[0];
  if (!devServerUrl) {
    throw new Error('Vite renderer dev server did not publish a local URL');
  }

  env.KNIFE_CURSOR_DEV_SERVER_URL = devServerUrl.replace(/\/+$/, '');

  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    throw new Error(`Electron executable not found: ${String(electronPath)}`);
  }

  const args = [
    '.',
    `--user-data-dir=${userDataDir}`,
    '--enable-logging=stderr',
  ];

  const useNoSandbox = process.env.KNIFE_CURSOR_ENABLE_SANDBOX !== '1';
  if (useNoSandbox) {
    args.push('--no-sandbox');
  }

  if (process.env.KNIFE_CURSOR_DISABLE_GPU === '1') {
    args.push('--disable-gpu');
  }

  // npm start -- --remote-debugging-port=9222
  args.push(...process.argv.slice(2).filter((arg) => arg !== '--'));

  log(
    `[dev] electron=${electronPath} ` +
      `noSandbox=${useNoSandbox} url=${env.KNIFE_CURSOR_DEV_SERVER_URL}`,
  );

  const child = spawn(electronPath, args, {
    cwd: projectRoot,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: false,
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    appendOutput('stdout', chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    appendOutput('stderr', chunk);
  });

  child.on('error', (error) => {
    log(`[dev] failed to launch Electron: ${error.stack ?? error}`);
    void server.close();
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    log(
      `[dev] Electron exited code=${code ?? 'null'} ` +
        `signal=${signal ?? 'null'}`,
    );
    void server.close().finally(() => {
      process.exit(signal ? 0 : code ?? 0);
    });
  });

  for (const forwardedSignal of ['SIGINT', 'SIGTERM']) {
    process.on(forwardedSignal, () => {
      log(`[dev] received ${forwardedSignal}, stopping Electron`);
      if (!child.killed) {
        child.kill(forwardedSignal);
      }
    });
  }
}

main().catch((error) => {
  log(`[dev] failed: ${error.stack ?? error}`);
  process.exit(1);
});