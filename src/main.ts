import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep this before every other import that can fail. A packaged app may die
// before Electron creates a window; the only useful evidence is a plain file
// next to the executable. If that directory is read-only (Program Files), also
// mirror to %TEMP% so the crash is never completely silent.
const CRASH_LOG_DIRECTORY =
  process.env.KNIFE_CURSOR_CRASH_DIR ?? path.dirname(process.execPath);
const CRASH_LOG_PATH = path.join(CRASH_LOG_DIRECTORY, 'crash.log');
const CRASH_FALLBACK_PATH = path.join(
  process.env.TEMP ?? process.env.TMP ?? process.cwd(),
  'knife-cursor-crash.log',
);

function logCrash(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;

  try {
    fs.appendFileSync(CRASH_LOG_PATH, line, 'utf8');
    return;
  } catch {
    // Fall through to the temp file.
  }

  try {
    fs.appendFileSync(CRASH_FALLBACK_PATH, line, 'utf8');
  } catch {
    // Logging must never be the reason the app fails.
  }
}

process.on('uncaughtException', (error: Error) => {
  logCrash(`Uncaught Exception: ${error.stack ?? error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const detail =
    reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  logCrash(`Unhandled Rejection: ${detail}`);
});

// This fires for a normal process.exit()/app.quit() as well. If it is absent
// after a silent exit, the main process died below JavaScript (native crash),
// which is exactly the distinction we need while diagnosing the packaged app.
process.on('exit', (code: number) => {
  logCrash(`Process exit code=${code}`);
});

logCrash(
  `App booting... electron=${process.versions.electron} ` +
    `execPath=${process.execPath} ` +
    `argv=${JSON.stringify(process.argv)} ` +
    `runAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? '(unset)'}`,
);

import type {
  BrowserWindow as ElectronBrowserWindow,
  Display,
  Menu as ElectronMenu,
  NativeImage,
  Rectangle,
  Tray as ElectronTray,
} from 'electron';

// Require Electron only after the crash handlers and the first log line above
// have run. A top-level `import` would be hoisted by the bundler and would load
// Electron (and potentially fail) before crash.log exists.
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  screen,
  Tray,
} = require('electron') as typeof import('electron');

// The custom-skin files live outside the app bundle. Expose them through a
// privileged scheme instead of file://: the renderer can request a normal image
// URL, while CSP keeps file:// and arbitrary network sources blocked.
const CUSTOM_SKIN_SCHEME = 'knife-asset';
protocol.registerSchemesAsPrivileged([
  {
    scheme: CUSTOM_SKIN_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

// This is a 2-D transparent overlay; it has no need for the GPU process.
// On machines with a broken/blocked GPU, Chromium otherwise retries the GPU
// process until it aborts with "GPU process isn't usable. Goodbye." Disabling
// hardware acceleration also avoids Chromium's GPU cache, which is where the
// non-ASCII Windows profile path was failing. Both calls must happen before
// app.whenReady(); calling disableHardwareAcceleration() afterwards throws.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
console.log('[main] GPU disabled: hardware acceleration off, --disable-gpu set');

// Last-resort switch for locked-down Windows sessions where the Chromium
// renderer cannot start at all. It is opt-in because --no-sandbox weakens the
// renderer security boundary; normal desktops must not run with it.
const FORCE_NO_SANDBOX = process.env.KNIFE_CURSOR_NO_SANDBOX === '1';
if (FORCE_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  console.warn('[main] no-sandbox fallback enabled by KNIFE_CURSOR_NO_SANDBOX=1');
  logCrash('No-sandbox fallback enabled by KNIFE_CURSOR_NO_SANDBOX=1');
}

// Diagnostic switches for isolating a native crash. They do not change the
// default behavior; they let the packaged app start without the hook or tray.
const DISABLE_HOOK_FOR_DIAGNOSTICS =
  process.env.KNIFE_CURSOR_DISABLE_HOOK === '1';
const DISABLE_TRAY_FOR_DIAGNOSTICS =
  process.env.KNIFE_CURSOR_DISABLE_TRAY === '1';

import os from 'node:os';
import {
  DEFAULT_CONFIG,
  isRetriggerMode,
  loadConfig,
  normalizeInspectionDuration,
  normalizeKnifeDisplaySize,
  normalizeOffset,
  normalizeSmoothingLevel,
  resetConfigToDefaults,
  saveConfig,
} from './main/config';
import type { AppConfig } from './main/config';
import {
  IDLE_ANIMATION_FPS,
  IPC_CHANNELS,
  SETTINGS_WINDOW_ARG,
} from './shared/ipc';
import type {
  ActionMapping,
  ActionScanResult,
  ActionSettings,
  ActiveActionData,
  CursorUpdate,
  DisplaySettings,
  IdleAnimationData,
  InspectionFinished,
  InspectionReset,
  InspectionStart,
  RetriggerMode,
  SkinSelectionResult,
  SkinState,
} from './shared/ipc';
import { generateActionId } from './shared/ipc';
import type { ActionKeyRecorded } from './shared/ipc';
import { uiohookKeyName } from './shared/keycodes';

const APP_NAME = 'Knife Cursor';
const APP_USER_MODEL_ID = 'com.knifecursor.overlay';
const OVERLAY_WINDOW_TITLE = 'Knife Cursor Overlay';
const CONFIG_FILENAME = 'config.json';
const CUSTOM_SKIN_FRAME_PATTERN = /^frame_(\d+)\.png$/i;
const CUSTOM_SKIN_IDLE_FILENAME = 'idle.png';
const CUSTOM_SKIN_HOST = 'skin';
const CUSTOM_SKIN_ACTION_HOST = 'action';

// electron-builder and the dev launcher no longer inject Forge's globals.
// A plain env var is set by scripts/dev.js; production loads the Vite output.
const DEV_RENDERER_URL =
  !app.isPackaged && process.env.KNIFE_CURSOR_DEV_SERVER_URL
    ? process.env.KNIFE_CURSOR_DEV_SERVER_URL.replace(/\/+$/, '')
    : '';
const RENDERER_DIR = path.join(__dirname, '../renderer/main_window');

const CURSOR_POLL_INTERVAL_MS = 16;
const DISPLAY_SYNC_DEBOUNCE_MS = 150;

// Windows has one topmost band. Within that band, the window most recently
// passed to SetWindowPos(HWND_TOP) wins. Electron maps setAlwaysOnTop(...,
// 'screen-saver') to HWND_TOPMOST and moveTop() to SetWindowPos(HWND_TOP), so
// re-asserting both is enough to sit above the taskbar and other topmost shells.
// No ffi/ref native dependency is needed for this: these are the same Win32
// calls, already made by Electron's native window implementation.
const OVERLAY_ALWAYS_ON_TOP_LEVEL = 'screen-saver' as const;
const OVERLAY_Z_ORDER_WATCHDOG_MS = 500;
const OVERLAY_Z_ORDER_THROTTLE_MS = 140;
const OVERLAY_Z_ORDER_RETRY_MS = 120;
const MIN_RETRIGGER_INTERVAL_MS = 50;
const INSPECTION_SAFETY_MARGIN_MS = 700;
const CONFIG_SAVE_DEBOUNCE_MS = 250;

// uiohook's virtual-key code for F. The native hook is the primary trigger.
const F_KEYCODE = 33;

// These are intentionally global shortcuts so the app remains usable when the
// low-level hook cannot start, or when Explorer's notification area rejects
// the tray icon. Ctrl+Shift+Alt+F is used instead of plain F: registering bare
// F would swallow every F typed into every application.
const FALLBACK_TRIGGER_SHORTCUT = 'CommandOrControl+Shift+Alt+F';
const OVERLAY_TOGGLE_SHORTCUT = 'CommandOrControl+Alt+0';
const EMERGENCY_QUIT_SHORTCUT = 'CommandOrControl+Alt+Shift+Q';
const FORCE_CURSOR_RESTORE_SHORTCUT = 'CommandOrControl+Alt+Shift+R';

// Restore is asynchronous and retried. A single PowerShell invocation can fail
// while the session is tearing down; the user's cursor must not stay invisible
// because of one transient failure. Stop/restore sequences are serialized so a
// fast settings toggle cannot race an in-flight helper teardown.
const CURSOR_RESTORE_MAX_ATTEMPTS = 5;
const CURSOR_RESTORE_RETRY_DELAY_MS = 150;
const CURSOR_HELPER_START_TIMEOUT_MS = 8000;
const RETRIGGER_MODE_SHORTCUTS = [
  { accelerator: 'CommandOrControl+Alt+1', mode: 'ignore' },
  { accelerator: 'CommandOrControl+Alt+2', mode: 'restart' },
] as const satisfies ReadonlyArray<{
  accelerator: string;
  mode: RetriggerMode;
}>;

type UiohookModule = typeof import('uiohook-napi');
type HookKeyEvent = { keycode: number; rawcode?: number };
type HookMouseEvent = import('uiohook-napi').UiohookMouseEvent;

interface OverlayWindow {
  displayId: number;
  window: ElectronBrowserWindow;
  loaded: boolean;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface LoadedCustomSkin {
  directory: string;
  idleUrl: string;
  frameUrls: string[];
  frameCount: number;
}

interface CustomSkinInspection {
  ok: boolean;
  directory: string;
  frames: string[];
  idleFile: string | null;
  error: string | null;
}

// ── V2.0 动作皮肤 ──
interface LoadedActionSkin {
  actionId: string;
  directory: string;
  idleUrl: string;
  frameUrls: string[];
  frameCount: number;
  actionName?: string;
}

const overlays = new Map<number, OverlayWindow>();

let displays: Display[] = [];
let cursorPoller: NodeJS.Timeout | null = null;
let displaySyncTimer: NodeJS.Timeout | null = null;
let overlayZOrderWatchdog: NodeJS.Timeout | null = null;
let overlayZOrderRetryTimer: NodeJS.Timeout | null = null;
let lastOverlayZOrderRaisedAt = 0;
let tray: ElectronTray | null = null;
let trayMenu: ElectronMenu | null = null;
let settingsWindow: ElectronBrowserWindow | null = null;
let cursorHiderPid: number | null = null;
let cursorHiderActive = false;
let cursorHiderWatchdog: NodeJS.Timeout | null = null;
let cursorDesiredHidden = false;
let cursorStartPromise: Promise<void> | null = null;
let cursorRestorePromise: Promise<boolean> | null = null;
// Restore invocations are serialized. Two concurrent PowerShell restores can
// race on SetSystemCursor and leave a destroyed transparent handle installed.
let cursorRestoreChain: Promise<boolean> = Promise.resolve(true);
// Stop is serialized too: settings-open and a fast toggle-off used to run two
// restore/kill sequences concurrently, letting a stale helper win the race.
let cursorStopChain: Promise<void> = Promise.resolve();
let terminationSignalHandled = false;
let overlayVisible = true;
let lastCursorPoint: ScreenPoint | null = null;
let quitting = false;
let quitCleanupStarted = false;
let quitCleanupComplete = false;
let devToolsOpened = false;

let appConfig: AppConfig = { ...DEFAULT_CONFIG };
let activeCustomSkin: LoadedCustomSkin | null = null;
let customSkinError: string | null = null;
let customSkinRevision = 0;

// ── V2.0 多动作状态 ──
let actionMappings: ActionMapping[] = [];
let activeActionId: string | null = null;
let perActionSkins = new Map<string, LoadedActionSkin>();
let perActionRevisions = new Map<string, number>();
let actionRootDirectory: string | null = null;

// ── 待机循环动画 ──
let idleActionId: string | null = null;
let idleAnimationSkin: LoadedActionSkin | null = null;
let idleAnimationSkinRevision = 0;

// ── 按键录制（主进程 uiohook 录制给设置窗口）──
let settingsRecordingActionId: string | null = null;

let configFilePath = '';
let configSaveTimer: NodeJS.Timeout | null = null;
let pendingConfigSaveReason = '';
let keepAliveTimer: NodeJS.Timeout | null = null;

// fKeyDown removed in V2.0; use activeActionKeys for per-key held tracking.
let activeInspectionId = 0;
let inspectionSequence = 0;
let lastInspectionStartedAt = 0;
let inspectionSafetyTimer: NodeJS.Timeout | null = null;

let uiohookModule: UiohookModule | null = null;
let uiohookListenersAttached = false;
let uiohookStarted = false;
let uiohookError: string | null = null;
let uiohookErrorShown = false;

app.setName(APP_NAME);
installTerminationHandlers();

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

if (process.platform === 'linux') {
  // Transparent windows need this on several Linux compositors.
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  return String(error);
}

function canWriteDirectory(directory: string): boolean {
  const probeFile = path.join(
    directory,
    `.knife-cursor-write-probe-${process.pid}-${Date.now()}`,
  );

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(probeFile, 'probe', { encoding: 'utf8', flag: 'wx' });
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    try {
      fs.unlinkSync(probeFile);
    } catch {
      // Best effort cleanup only.
    }
    return false;
  }
}

function cleanPathValue(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1');
}

/**
 * Build a 1x1 fully transparent Windows cursor. The 32-bit DIB contains one
 * transparent XOR pixel plus a 4-byte AND mask. Keeping this as a tiny buffer
 * avoids shipping another binary asset and, more importantly, keeps the cursor
 * path writable (PowerShell cannot load a cursor from inside app.asar).
 */
function createBlankCursorBuffer(): Buffer {
  const buffer = Buffer.alloc(70);

  buffer.writeUInt16LE(0, 0); // reserved
  buffer.writeUInt16LE(2, 2); // resource type: cursor
  buffer.writeUInt16LE(1, 4); // one image
  buffer[6] = 1; // width
  buffer[7] = 1; // height
  buffer[8] = 0; // color count
  buffer[9] = 0; // reserved
  buffer.writeUInt16LE(0, 10); // hotspot x
  buffer.writeUInt16LE(0, 12); // hotspot y
  buffer.writeUInt32LE(48, 14); // image bytes: 40 + 4 XOR + 4 AND
  buffer.writeUInt32LE(22, 18); // image offset

  buffer.writeUInt32LE(40, 22); // BITMAPINFOHEADER size
  buffer.writeInt32LE(1, 26); // width
  buffer.writeInt32LE(2, 30); // height (XOR + AND)
  buffer.writeUInt16LE(1, 34); // planes
  buffer.writeUInt16LE(32, 36); // bits per pixel
  buffer.writeUInt32LE(0, 38); // BI_RGB
  buffer.writeUInt32LE(8, 42); // image size
  buffer.writeInt32LE(0, 46); // x pixels/meter
  buffer.writeInt32LE(0, 50); // y pixels/meter
  buffer.writeUInt32LE(0, 54); // colors used
  buffer.writeUInt32LE(0, 58); // important colors
  // XOR pixel is already zero; the AND mask all-ones makes it transparent.
  buffer.fill(0xff, 66, 70);

  return buffer;
}

interface CursorHiderFiles {
  directory: string;
  scriptPath: string;
  cursorPath: string;
  stopPath: string;
  logPath: string;
  stdoutPath: string;
  stderrPath: string;
  pidPath: string;
}

function ensureCursorHiderFiles(): CursorHiderFiles {
  const directory = path.join(app.getPath('userData'), 'cursor-helper');
  const scriptPath = path.join(directory, 'system-cursor.ps1');
  const cursorPath = path.join(directory, 'blank-cursor.cur');
  const stopPath = path.join(directory, 'restore.request');
  const logPath = path.join(directory, 'system-cursor.log');
  const stdoutPath = path.join(directory, 'helper.stdout.log');
  const stderrPath = path.join(directory, 'helper.stderr.log');
  const pidPath = path.join(directory, 'helper.pid');
  const sourcePath = path.join(
    app.getAppPath(),
    'assets',
    'system-cursor.ps1',
  );

  fs.mkdirSync(directory, { recursive: true });

  if (cursorHiderScriptNeedsCopy(sourcePath, scriptPath)) {
    fs.copyFileSync(sourcePath, scriptPath);
  }

  const scriptSize = fs.statSync(scriptPath).size;
  if (scriptSize === 0) {
    throw new Error(`Cursor helper script is empty: ${scriptPath}`);
  }

  fs.writeFileSync(cursorPath, createBlankCursorBuffer());

  return {
    directory,
    scriptPath,
    cursorPath,
    stopPath,
    logPath,
    stdoutPath,
    stderrPath,
    pidPath,
  };
}

function readTextFileTail(filePath: string, maxChars = 6000): string {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

/**
 * Keep the exact paths in both the console and crash.log. Packaged builds use
 * %APPDATA%\Knife Cursor (contains a space), so a wrong copy path or a missing
 * asar asset must be visible without attaching a debugger.
 */
function logCursorHelperPaths(files: CursorHiderFiles, reason: string): void {
  const sourcePath = path.join(
    app.getAppPath(),
    'assets',
    'system-cursor.ps1',
  );
  let sourceBytes = -1;
  let scriptBytes = -1;
  try {
    sourceBytes = fs.statSync(sourcePath).size;
  } catch {
    // The diagnostic below deliberately records -1.
  }
  try {
    scriptBytes = fs.statSync(files.scriptPath).size;
  } catch {
    // The diagnostic below deliberately records -1.
  }

  const message =
    `[cursor] helper paths reason=${reason} ` +
    `appPath=${app.getAppPath()} source=${sourcePath} sourceBytes=${sourceBytes} ` +
    `script=${files.scriptPath} scriptBytes=${scriptBytes} ` +
    `userData=${app.getPath('userData')} temp=${files.directory}\\temp`;
  console.log(message);
  logCrash(message);
}

/**
 * Dump the helper's own log plus its redirected stdout/stderr. This is the
 * only way to see Add-Type, execution-policy or access-denied failures from a
 * detached PowerShell process in the packaged app.
 */
function logCursorHelperOutput(files: CursorHiderFiles, reason: string): void {
  const outputs: Array<[string, string]> = [
    ['helper.stderr', readTextFileTail(files.stderrPath)],
    ['helper.stdout', readTextFileTail(files.stdoutPath)],
    ['system-cursor.log', readTextFileTail(files.logPath)],
  ];

  for (const [label, text] of outputs) {
    if (text.length === 0) {
      continue;
    }
    const message = `System cursor ${label} (${reason}):\n${text}`;
    console.warn(message);
    logCrash(message);
  }
}

function cursorHiderScriptNeedsCopy(
  sourcePath: string,
  destinationPath: string,
): boolean {
  try {
    const sourceStat = fs.statSync(sourcePath);
    const destinationStat = fs.statSync(destinationPath);
    return (
      sourceStat.size !== destinationStat.size ||
      sourceStat.mtimeMs > destinationStat.mtimeMs
    );
  } catch {
    return true;
  }
}

function cursorHelperEnvironment(files: CursorHiderFiles): NodeJS.ProcessEnv {
  const tempDirectory = path.join(files.directory, 'temp');
  fs.mkdirSync(tempDirectory, { recursive: true });

  // app.getPath('temp') can itself be C:\Temp, which is not writable for a
  // normal user. Add-Type must create temporary compiler files, so point
  // PowerShell at a directory we know is writable.
  return {
    ...process.env,
    TEMP: tempDirectory,
    TMP: tempDirectory,
  };
}



function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function psDoubleQuoted(value: string): string {
  // Start-Process joins -ArgumentList with spaces. Every value must therefore
  // be quoted, and PowerShell metacharacters inside the double quotes escaped.
  return '"' + value.replace(/["`$]/g, (match) => '`' + match) + '"';
}

function readCursorHiderPid(files: CursorHiderFiles): number | null {
  try {
    const raw = fs.readFileSync(files.pidPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Run one PowerShell process without touching Electron's main thread.
 *
 * `spawnSync` is intentionally gone from the cursor path. A restore can take a
 * full second on Windows 11 (WM_SETCURSOR + pointer refresh), and blocking the
 * main thread there made the tray menu and settings window feel frozen.
 */
function runPowerShellAsync(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  label = 'powershell',
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const captureLimit = 32_000;

    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      // Keep both streams. stdio:'ignore' hides Add-Type, execution-policy,
      // path and Access Denied errors from the packaged app.
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-captureLimit);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-captureLimit);
    });

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (stdout.trim().length > 0) {
        const message = `PowerShell [${label}] stdout:\n${stdout.trim()}`;
        console.log(message);
        logCrash(message);
      }
      if (stderr.trim().length > 0) {
        const message = `PowerShell [${label}] stderr:\n${stderr.trim()}`;
        console.warn(message);
        logCrash(message);
      }

      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
      finish(
        new Error(
          `PowerShell [${label}] timed out after ${timeoutMs}ms` +
            (stderr.trim() ? `; stderr: ${stderr.trim().slice(-2000)}` : ''),
        ),
      );
    }, timeoutMs);
    timer.unref();

    child.once('error', (error: Error) => {
      finish(error);
    });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `PowerShell [${label}] exited with code=${String(code)} signal=${String(signal)}` +
            (stderr.trim() ? `; stderr: ${stderr.trim().slice(-2000)}` : ''),
        ),
      );
    });
  });
}

/** Kill exactly one helper process (and its children), never all PowerShell. */
function killCursorHelperProcess(pid: number, reason: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      finish();
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      finish();
    }, 2500);
    timer.unref();

    child.once('error', finish);
    child.once('exit', () => {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid);
        } catch {
          // Best effort; the restore below is the important part.
        }
      }
      console.log(`[cursor] helper killed reason=${reason} pid=${pid}`);
      logCrash(`System cursor helper killed: ${reason} pid=${pid}`);
      finish();
    });
  });
}

/**
 * If helper.pid was lost, find only processes whose command line contains our
 * copied system-cursor.ps1 path. This is the safe equivalent of the requested
 * `taskkill /IM powershell.exe`: it never kills the user's terminals or IDE.
 */
async function killOrphanCursorHelpers(
  files: CursorHiderFiles,
  reason: string,
): Promise<void> {
  const scriptPath = psSingleQuoted(files.scriptPath);
  const command = [
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + " +
      scriptPath +
      " + '*') -and $_.CommandLine -notlike '*-RestoreOnly*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join('; ');

  try {
    await runPowerShellAsync(
      ['-NoProfile', '-NonInteractive', '-Command', command],
      cursorHelperEnvironment(files),
      4000,
      `orphan-scan:${reason}`,
    );
    console.log(`[cursor] orphan helper scan complete reason=${reason}`);
    logCrash(`System cursor orphan helper scan: ${reason}`);
  } catch (error) {
    console.warn('[cursor] orphan helper scan failed', error);
    logCrash(`System cursor orphan helper scan failed: ${describeError(error)}`);
  }
}

function stopCursorHiderWatchdog(): void {
  if (cursorHiderWatchdog !== null) {
    clearInterval(cursorHiderWatchdog);
    cursorHiderWatchdog = null;
  }
}

function startCursorHiderWatchdog(): void {
  if (cursorHiderWatchdog !== null || !cursorHiderActive) {
    return;
  }

  cursorHiderWatchdog = setInterval(() => {
    if (!cursorHiderActive || cursorHiderPid === null) {
      return;
    }

    if (isProcessAlive(cursorHiderPid)) {
      return;
    }

    const deadPid = cursorHiderPid;
    cursorHiderPid = null;
    cursorHiderActive = false;
    stopCursorHiderWatchdog();
    console.warn(`[cursor] helper pid=${deadPid} exited unexpectedly`);
    logCrash(`System cursor hider pid=${deadPid} exited unexpectedly`);
    try {
      const files = ensureCursorHiderFiles();
      logCursorHelperOutput(files, 'helper-process-exited');
    } catch (error) {
      logCrash(
        `Could not read cursor helper diagnostics: ${describeError(error)}`,
      );
    }
    void runCursorRestore('helper-process-exited', 3);
  }, 1000);
}

function runCursorRestore(
  reason: string,
  attempts = CURSOR_RESTORE_MAX_ATTEMPTS,
): Promise<boolean> {
  if (process.platform !== 'win32') {
    return Promise.resolve(true);
  }

  const task = cursorRestoreChain
    .catch(() => false)
    .then(() => runCursorRestoreNow(reason, attempts));
  cursorRestoreChain = task.catch(() => false);

  let tracked: Promise<boolean>;
  tracked = task.finally(() => {
    if (cursorRestorePromise === tracked) {
      cursorRestorePromise = null;
    }
  });
  cursorRestorePromise = tracked;
  return tracked;
}

async function runCursorRestoreNow(
  reason: string,
  attempts: number,
): Promise<boolean> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const files = ensureCursorHiderFiles();
      await runPowerShellAsync(
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          files.scriptPath,
          '-RestoreOnly',
          '-LogPath',
          files.logPath,
        ],
        cursorHelperEnvironment(files),
        5000,
        `restore:${reason}:attempt-${attempt}`,
      );

      console.log(
        `[cursor] system cursor restored reason=${reason} attempt=${attempt}`,
      );
      logCrash(`System cursor restore: ${reason} attempt=${attempt}`);
      return true;
    } catch (error) {
      lastError = error;
      console.warn(
        `[cursor] restore attempt ${attempt}/${attempts} failed (${reason})`,
        error,
      );
      logCrash(
        `System cursor restore attempt ${attempt}/${attempts} failed ` +
          `(${reason}): ${describeError(error)}`,
      );
      if (attempt < attempts) {
        await delay(CURSOR_RESTORE_RETRY_DELAY_MS);
      }
    }
  }

  console.error(
    `[cursor] FAILED to restore system cursor after ${attempts} attempts (${reason})`,
    lastError,
  );
  logCrash(
    `System cursor restore FAILED after ${attempts} attempts (${reason}): ` +
      describeError(lastError),
  );
  return false;
}

function startSystemCursorHider(reason: string): Promise<void> {
  // Keep every caller (bootstrap, overlay toggle, settings close, tray close)
  // consistent with the persisted switch. The env override is an emergency
  // escape hatch for users who never want their cursor touched.
  if (
    process.platform !== 'win32' ||
    !appConfig.hideSystemCursor ||
    process.env.KNIFE_CURSOR_KEEP_SYSTEM_CURSOR === '1'
  ) {
    cursorDesiredHidden = false;
    return Promise.resolve();
  }

  cursorDesiredHidden = true;

  if (cursorStartPromise !== null) {
    return cursorStartPromise;
  }

  const task = startSystemCursorHiderNow(reason);
  let tracked: Promise<void>;
  tracked = task.finally(() => {
    if (cursorStartPromise === tracked) {
      cursorStartPromise = null;
    }
  });
  cursorStartPromise = tracked;
  return tracked;
}

async function startSystemCursorHiderNow(reason: string): Promise<void> {
  if (
    process.platform !== 'win32' ||
    !appConfig.hideSystemCursor ||
    process.env.KNIFE_CURSOR_KEEP_SYSTEM_CURSOR === '1' ||
    !overlayVisible ||
    !cursorDesiredHidden ||
    quitting
  ) {
    return;
  }

  // A tray menu can close before the previous restore has finished. Hide only
  // after the whole stop sequence is done, otherwise the arrow can reappear
  // over the overlay while the helper believes it is active.
  await cursorStopChain.catch(() => undefined);
  if (cursorRestorePromise !== null) {
    await cursorRestorePromise.catch(() => false);
  }

  if (
    !appConfig.hideSystemCursor ||
    process.env.KNIFE_CURSOR_KEEP_SYSTEM_CURSOR === '1' ||
    !overlayVisible ||
    !cursorDesiredHidden ||
    quitting
  ) {
    return;
  }

  if (
    cursorHiderActive &&
    cursorHiderPid !== null &&
    isProcessAlive(cursorHiderPid)
  ) {
    return;
  }

  let diagnosticFiles: CursorHiderFiles | null = null;

  try {
    const files = ensureCursorHiderFiles();
    diagnosticFiles = files;
    fs.rmSync(files.stdoutPath, { force: true });
    fs.rmSync(files.stderrPath, { force: true });
    fs.rmSync(files.logPath, { force: true });
    logCursorHelperPaths(files, reason);

    if (!fs.existsSync(files.scriptPath)) {
      throw new Error(`Cursor helper script missing: ${files.scriptPath}`);
    }

    // A helper left over from a previous run might still own the cursor.
    const stalePid = readCursorHiderPid(files);
    if (stalePid !== null && isProcessAlive(stalePid)) {
      try {
        fs.writeFileSync(files.stopPath, 'stop', 'utf8');
        process.kill(stalePid);
      } catch {
        // The stale helper will also self-terminate when its parent is gone.
      }
    }

    fs.rmSync(files.stopPath, { force: true });
    fs.rmSync(files.pidPath, { force: true });

    // Start-Process creates a separate, hidden PowerShell console. That
    // detachment is essential: closing the terminal kills the npm/Electron
    // console group, but must not kill the cursor guard before it restores.
    // A direct `detached: true` spawn makes PowerShell exit before the script
    // runs in this Electron build, so use this one-shot launcher instead.
    const helperArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      files.scriptPath,
      '-ParentPid',
      String(process.pid),
      '-CursorPath',
      files.cursorPath,
      '-StopPath',
      files.stopPath,
      '-LogPath',
      files.logPath,
    ];
    // Start-Process does not preserve embedded quotes when an array is passed to
    // -ArgumentList. A single pre-quoted string keeps "Knife Cursor" (the
    // packaged userData path has a space) as one -File argument.
    const quotedArgs = helperArgs.map(psDoubleQuoted).join(' ');
    const launcherCommand = [
      "$ErrorActionPreference = 'Stop'",
      '$helper = Start-Process -FilePath ' +
        "'powershell.exe' -WindowStyle Hidden -PassThru " +
        `-RedirectStandardOutput ${psSingleQuoted(files.stdoutPath)} ` +
        `-RedirectStandardError ${psSingleQuoted(files.stderrPath)} ` +
        `-ArgumentList ${psSingleQuoted(quotedArgs)}`,
      'if ($null -eq $helper) { exit 2 }',
      'Set-Content -LiteralPath ' +
        `${psSingleQuoted(files.pidPath)} -Value $helper.Id -Encoding ASCII`,
    ].join('; ');
    const encodedLauncher = Buffer.from(
      launcherCommand,
      'utf16le',
    ).toString('base64');

    await runPowerShellAsync(
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodedLauncher,
      ],
      cursorHelperEnvironment(files),
      5000,
      `start-helper-launcher:${reason}`,
    );

    if (!cursorDesiredHidden || quitting) {
      fs.writeFileSync(files.stopPath, 'stop', 'utf8');
      return;
    }

    const deadline = Date.now() + CURSOR_HELPER_START_TIMEOUT_MS;
    let helperPid: number | null = null;

    while (Date.now() < deadline) {
      helperPid = readCursorHiderPid(files);
      if (helperPid !== null && isProcessAlive(helperPid)) {
        break;
      }
      helperPid = null;
      await delay(50);
      if (!cursorDesiredHidden || quitting) {
        fs.writeFileSync(files.stopPath, 'stop', 'utf8');
        return;
      }
    }

    if (helperPid === null) {
      throw new Error('Cursor helper did not publish a live pid');
    }

    if (!cursorDesiredHidden || quitting) {
      try {
        fs.writeFileSync(files.stopPath, 'stop', 'utf8');
      } catch {
        // The helper will also exit when its parent disappears.
      }
      return;
    }

    cursorHiderPid = helperPid;
    cursorHiderActive = true;
    startCursorHiderWatchdog();

    console.log(
      `[cursor] system cursor hider started reason=${reason} pid=${helperPid}`,
    );
    logCrash(`System cursor hider started: ${reason} pid=${helperPid}`);
  } catch (error) {
    cursorHiderPid = null;
    cursorHiderActive = false;
    stopCursorHiderWatchdog();

    // A slow Start-Process may publish its pid just after our timeout. Ask any
    // such late helper to stop, then restore so we cannot leave the cursor
    // hidden while the watchdog believes nothing is running.
    try {
      const files = ensureCursorHiderFiles();
      fs.writeFileSync(files.stopPath, 'stop', 'utf8');
    } catch {
      // Best effort; the restore attempt below is the important part.
    }
    await runCursorRestore('helper-start-failed', 3);

    console.warn('[cursor] failed to hide system cursor', error);
    logCrash(`System cursor hide failed (${reason}): ${describeError(error)}`);
    if (diagnosticFiles !== null) {
      logCursorHelperOutput(diagnosticFiles, 'helper-start-failed');
    }
  }
}

function stopSystemCursorHider(reason: string): Promise<void> {
  cursorDesiredHidden = false;
  // Do not let a start that is still waiting on the restore cache block a new
  // "hide" toggle. Its checks will see cursorDesiredHidden=false and abort.
  cursorStartPromise = null;

  const task = cursorStopChain
    .catch(() => undefined)
    .then(() => stopSystemCursorHiderNow(reason));
  cursorStopChain = task.catch(() => undefined);
  return task;
}

async function stopSystemCursorHiderNow(reason: string): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  let files: CursorHiderFiles | null = null;
  let helperPid = cursorHiderPid;

  try {
    files = ensureCursorHiderFiles();
    helperPid = helperPid ?? readCursorHiderPid(files);
    fs.writeFileSync(files.stopPath, 'stop', 'utf8');
  } catch (error) {
    console.warn('[cursor] failed to write stop request', error);
  }

  const wasActive = cursorHiderActive;
  const helperWasAlive =
    helperPid !== null ? isProcessAlive(helperPid) : false;
  console.log(
    `[cursor] stop requested reason=${reason} active=${String(wasActive)} ` +
      `pid=${String(helperPid ?? 'none')} alive=${String(helperWasAlive)}`,
  );

  cursorHiderActive = false;
  cursorHiderPid = null;
  stopCursorHiderWatchdog();

  // Kill the owner before restoring. If the helper is hung in SetSystemCursor,
  // a restore that races it can finish first and the helper can then put the
  // blank handle back. taskkill is scoped to the helper PID/tree; never use
  // `/IM powershell.exe`, which would also kill the user's terminals and IDE.
  if (helperPid !== null && isProcessAlive(helperPid)) {
    await killCursorHelperProcess(helperPid, reason);
  } else if (files !== null) {
    // helper.pid can be lost after a crash. Remove only processes running our
    // exact copied script, not every PowerShell process.
    await killOrphanCursorHelpers(files, reason);
  }

  // Always restore. Do not skip this when our in-memory state says "inactive":
  // a helper from a previous force-restore or a lost PID must still be cleaned
  // up, and Windows 11 needs the active SetSystemCursor restore, not just an
  // SPI_SETCURSORS no-op. This is also the path used by Ctrl+Alt+0.
  const restored = await runCursorRestore(
    reason,
    CURSOR_RESTORE_MAX_ATTEMPTS,
  );

  if (!restored) {
    logCrash(
      `System cursor restore still failed after killing helper (${reason})`,
    );
  }

  // A taskkill timeout can leave the helper alive. Do one final precise kill
  // after the restore; this must not depend on restore success.
  if (helperPid !== null && isProcessAlive(helperPid)) {
    await killCursorHelperProcess(helperPid, `${reason}-post-restore`);
  }
}

function forceRestoreSystemCursor(): void {
  console.log('[cursor] force restore requested');
  logCrash('Force system cursor restore requested');
  // stop() always runs the active Windows 11 restore path now, even when the
  // in-memory PID is already gone. Do not run a second 1-second restore here.
  void stopSystemCursorHider('force-restore-shortcut');
}

function installTerminationHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (terminationSignalHandled) {
      return;
    }

    terminationSignalHandled = true;
    console.warn(`[main] received ${signal}; restoring system cursor`);
    logCrash(`Received ${signal}; restoring system cursor before exit`);

    let exited = false;
    const exitNow = (): void => {
      if (exited) {
        return;
      }
      exited = true;
      try {
        app.exit(0);
      } catch {
        process.exit(0);
      }
    };

    // Closing a terminal can kill the console group at any moment. Keep the
    // fallback timer short; the detached helper also restores by itself when
    // the parent disappears.
    const fallback = setTimeout(exitNow, 2500);

    void stopSystemCursorHider(`signal-${signal}`)
      .then(() =>
        runCursorRestore(
          `signal-${signal}-final`,
          CURSOR_RESTORE_MAX_ATTEMPTS,
        ),
      )
      .catch((error: unknown) => {
        console.warn('[cursor] signal restore failed', error);
      })
      .finally(() => {
        clearTimeout(fallback);
        exitNow();
      });
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    try {
      process.on(signal, () => handleSignal(signal));
    } catch (error) {
      console.warn(`[main] could not register ${signal} handler`, error);
    }
  }
}

function showTrayMenu(): void {
  if (tray === null || trayMenu === null) {
    return;
  }

  // The native menu needs a visible pointer. Start the restore but do not wait:
  // the native popup must appear immediately. menu-will-close starts the hider
  // again, and startSystemCursorHider() waits for this restore first.
  void stopSystemCursorHider('tray-menu-open');

  try {
    tray.popUpContextMenu(trayMenu);
  } catch (error) {
    console.warn('[tray] popUpContextMenu failed', error);
    void startSystemCursorHider('tray-menu-failed');
  }
}

/**
 * Chromium writes its singleton lock and GPU cache inside userData before any
 * window exists. If that directory is not writable, Electron exits silently.
 * Choose a writable directory before requestSingleInstanceLock().
 */
function resolveUserDataDirectory(): string {
  const explicitPath =
    process.env.KNIFE_CURSOR_USER_DATA ??
    app.commandLine.getSwitchValue('user-data-dir');

  if (explicitPath.trim() !== '') {
    const resolved = path.resolve(cleanPathValue(explicitPath));
    if (canWriteDirectory(resolved)) {
      return resolved;
    }

    console.warn(`[main] userData is not writable: ${resolved}; falling back`);
  }

  const appData =
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

  const candidates = [
    path.join(appData, APP_NAME),
    path.join(localAppData, APP_NAME),
    path.join(path.dirname(process.execPath), 'KnifeCursorData'),
    path.join(os.homedir(), '.knife-cursor'),
    path.join(os.tmpdir(), APP_NAME),
  ];

  for (const candidate of new Set(candidates)) {
    if (canWriteDirectory(candidate)) {
      return candidate;
    }
  }

  return path.join(os.tmpdir(), APP_NAME);
}

const userDataDirectory = resolveUserDataDirectory();

try {
  app.setPath('userData', userDataDirectory);
  console.log(`[main] userData=${userDataDirectory}`);
  logCrash(`User data resolved: ${userDataDirectory}`);
} catch (error) {
  console.error('[main] could not set userData path', error);
  logCrash(`Could not set user data path: ${describeError(error)}`);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
logCrash(`Single instance lock=${String(hasSingleInstanceLock)}`);

if (!hasSingleInstanceLock) {
  console.error('[main] another instance is already running; exiting');
  logCrash('Another instance is already running; exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!app.isReady()) {
      return;
    }

    if (!overlayVisible) {
      setOverlayEnabled(true);
      return;
    }

    showAllOverlays();
  });

  app.whenReady()
    .then(() => {
      logCrash('Electron app ready');
      bootstrap();
      logCrash('Bootstrap complete; app should now stay resident');
    })
    .catch((error: unknown) => {
      console.error('[main] failed to start', error);
      logCrash(`Failed to start: ${describeError(error)}`);
      dialog.showErrorBox(
        'Knife Cursor 启动失败',
        describeError(error),
      );
      app.quit();
    });

  app.on('before-quit', (event) => {
    logCrash('Event before-quit');

    if (quitCleanupComplete) {
      return;
    }

    // Cursor restore is asynchronous so it never freezes the UI. Delay the
    // actual quit until it finishes; otherwise app.quit() would tear down the
    // process while PowerShell is still restoring the arrow.
    event.preventDefault();
    if (quitCleanupStarted) {
      return;
    }

    quitCleanupStarted = true;
    void teardown()
      .catch((error: unknown) => {
        console.error('[main] teardown failed', error);
        logCrash(`Teardown failed: ${describeError(error)}`);
      })
      .finally(() => {
        quitCleanupComplete = true;
        app.quit();
      });
  });

  app.on('will-quit', () => {
    logCrash('Event will-quit');
  });

  app.on('quit', (_event, exitCode: number) => {
    logCrash(`Event quit exitCode=${exitCode}`);
  });

  app.on('window-all-closed', () => {
    // Deliberately do not call app.quit(). This utility is tray/hook resident;
    // even if every overlay disappears, the main process must remain alive so
    // the fallback shortcut can recreate the windows.
    logCrash('Event window-all-closed; keeping main process alive');
    startKeepAliveTimer();
  });

  app.on('child-process-gone', (_event, details) => {
    logCrash(
      `Event child-process-gone type=${details.type} ` +
        `reason=${details.reason} exitCode=${details.exitCode} ` +
        `service=${details.serviceName ?? '(none)'}`,
    );
  });
}

function bootstrap(): void {
  logCrash('Bootstrap begin');
  Menu.setApplicationMenu(null);

  loadAppConfig();
  // ── V2.0 动作映射从配置同步到运行时 ──
  actionMappings = [...appConfig.actionMappings];
  logCrash(`Bootstrap: loaded ${actionMappings.length} action mappings`);

  // ── 待机循环动画初始化 ──
  idleActionId = appConfig.idleActionId ?? null;
  if (idleActionId !== null) {
    updateIdleAnimation(idleActionId);
    logCrash(`Bootstrap: idle animation set actionId="${idleActionId}"`);
  }
  registerCustomSkinProtocol();
  loadCustomSkinFromConfig();
  registerIpcHandlers();
  registerPowerEvents();
  registerShortcuts();
  logCrash('Bootstrap: config/IPC/power/shortcuts registered');

  logCrash('Bootstrap: creating tray');
  createTray();
  logCrash('Bootstrap: tray phase done');

  logCrash('Bootstrap: creating overlay windows');
  syncOverlays();
  startOverlayZOrderWatchdog();
  logCrash('Bootstrap: overlay phase done');

  // Clear a blank cursor left behind by a previous hard kill, then hide the
  // real Windows cursors for as long as the overlay is active. The helper
  // restores the user's scheme when this process exits or is paused.
  void runCursorRestore('startup-guard');
  void startSystemCursorHider('bootstrap');

  logCrash('Bootstrap: starting keyboard hook');
  startKeyboardHook();
  logCrash('Bootstrap: keyboard hook phase done');

  startCursorLoop();
  startKeepAliveTimer();
  logCrash('Bootstrap: cursor loop and keepalive armed');

  screen.on('display-added', scheduleDisplaySync);
  screen.on('display-removed', scheduleDisplaySync);
  screen.on('display-metrics-changed', scheduleDisplaySync);

  app.on('activate', () => {
    logCrash('Event activate');
    if (!overlayVisible) {
      setOverlayEnabled(true);
      return;
    }

    showAllOverlays();
  });

  console.log(
    `[main] ready electron=${process.versions.electron} ` +
      `userData=${app.getPath('userData')} packaged=${app.isPackaged} ` +
      `temp=${app.getPath('temp')} envTEMP=${process.env.TEMP ?? '<unset>'} ` +
      `envTMP=${process.env.TMP ?? '<unset>'}`,
  );

  // Development-only smoke-test hook: the tray is unavailable in some remote
  // Windows sessions, so allow opening the settings window directly.
  if (!app.isPackaged && process.env.KNIFE_CURSOR_OPEN_SETTINGS === '1') {
    openSettingsWindow();
  }
}

function startKeepAliveTimer(): void {
  if (keepAliveTimer !== null || quitting) {
    return;
  }

  // A live timer is the last line of defence against an accidental
  // window-all-closed exit. The interval is deliberately empty: it only keeps
  // the main process' event loop alive, and costs effectively nothing.
  keepAliveTimer = setInterval(() => {
    if (quitting) {
      return;
    }
  }, 30_000);

  logCrash('Main-process keepalive timer armed (30s)');
}

function stopKeepAliveTimer(): void {
  if (keepAliveTimer === null) {
    return;
  }

  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function loadAppConfig(): void {
  configFilePath = path.join(app.getPath('userData'), CONFIG_FILENAME);
  const result = loadConfig(configFilePath);
  appConfig = result.config;
  overlayVisible = appConfig.overlayEnabled;

  if (result.warning !== null) {
    console.warn(`[config] ${result.warning}; using defaults`);
  }

  console.log(
    `[config] path=${configFilePath} retriggerMode=${appConfig.retriggerMode} ` +
      `overlayEnabled=${appConfig.overlayEnabled} ` +
      `duration=${appConfig.inspectionDurationMs}ms ` +
      `size=${appConfig.knifeDisplaySize}px`,
  );
}

function persistAppConfig(reason: string): void {
  if (configSaveTimer !== null) {
    clearTimeout(configSaveTimer);
    configSaveTimer = null;
  }
  pendingConfigSaveReason = '';

  try {
    saveConfig(configFilePath, appConfig);
    console.log(
      `[config] saved reason=${reason} retriggerMode=${appConfig.retriggerMode} ` +
        `overlayEnabled=${appConfig.overlayEnabled} ` +
        `duration=${appConfig.inspectionDurationMs}ms ` +
        `size=${appConfig.knifeDisplaySize}px`,
    );
  } catch (error) {
    console.error('[config] save failed', error);
  }

  refreshTrayMenu();
}

/**
 * Reset all runtime state to factory defaults, write a clean config.json,
 * and notify every connected window.  Call this from the "恢复出厂设置"
 * IPC handler (Settings window).  The caller is responsible for restarting
 * or refreshing after this returns.
 */
function resetAppConfig(): void {
  // ── 1. Write clean config to disk ──
  appConfig = resetConfigToDefaults(configFilePath);

  // ── 2. Reset associated runtime state ──
  overlayVisible = appConfig.overlayEnabled; // true
  activeCustomSkin = null;
  customSkinError = null;
  customSkinRevision += 1;
  actionMappings = [];
  activeActionId = null;
  perActionSkins.clear();
  perActionRevisions.clear();

  // ── 2b. Clear idle animation state ──
  if (idleActionId !== null) {
    idleActionId = null;
    idleAnimationSkin = null;
    idleAnimationSkinRevision = 0;
    sendIdleAnimationToOverlays(buildIdleAnimationData(null));
  }

  // ── 3. Sync overlay visibility ──
  if (overlayVisible) {
    showAllOverlays();
    void startSystemCursorHider('config-reset');
  } else {
    stopCursorLoop();
    lastCursorPoint = null;
    forceIdle('config-reset');
    for (const overlay of overlays.values()) {
      hideOverlay(overlay);
    }
    void stopSystemCursorHider('config-reset');
  }

  // ── 3b. When the factory default is "don't hide cursor", force a restore
  // even if overlayVisible === true.  The user may have hidden the cursor
  // before hitting the reset button; startSystemCursorHider would be a
  // no-op in that case and the arrow would stay invisible.
  if (!appConfig.hideSystemCursor && cursorHiderActive) {
    console.log('[config] factory reset: restoring system cursor');
    void stopSystemCursorHider('config-reset-cursor');
  }

  // ── 4. Rebuild tray menu labels ──
  refreshTrayMenu();

  // ── 5. Notify every overlay: revert to built-in art + global settings ──
  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    const displaySettings: DisplaySettings = {
      knifeDisplaySize: appConfig.knifeDisplaySize,
      inspectionDurationMs: appConfig.inspectionDurationMs,
      offsetX: appConfig.offsetX,
      offsetY: appConfig.offsetY,
      smoothingLevel: appConfig.smoothingLevel,
      hideSystemCursor: appConfig.hideSystemCursor,
    };

    try {
      overlay.window.webContents.send(
        IPC_CHANNELS.actionActivated,
        {
          actionId: null,
          actionName: 'built-in',
          idleUrl: '',
          frameUrls: [],
          frameCount: 0,
          effectiveSettings: displaySettings,
        },
      );
      overlay.window.webContents.send(
        IPC_CHANNELS.displaySettings,
        displaySettings,
      );
    } catch {
      // overlay may be tearing down
    }
  }

  logCrash('[config] factory reset complete');
  console.log('[config] factory reset complete');
}

/**
 * Slider input can fire dozens of times per second. Apply each change in
 * memory immediately, but coalesce disk writes so dragging does not hammer
 * the config file.
 */
function schedulePersistAppConfig(reason: string): void {
  pendingConfigSaveReason = reason;

  if (configSaveTimer !== null) {
    return;
  }

  configSaveTimer = setTimeout(() => {
    configSaveTimer = null;
    persistAppConfig(pendingConfigSaveReason || 'display-settings');
  }, CONFIG_SAVE_DEBOUNCE_MS);
}

function flushPendingConfigSave(): void {
  if (configSaveTimer === null) {
    return;
  }

  persistAppConfig(pendingConfigSaveReason || 'quit');
}

function setRetriggerMode(mode: RetriggerMode): void {
  if (!isRetriggerMode(mode) || appConfig.retriggerMode === mode) {
    refreshTrayMenu();
    return;
  }

  appConfig = { ...appConfig, retriggerMode: mode };
  console.log(`[inspect] retriggerMode=${mode}`);
  persistAppConfig(`retriggerMode=${mode}`);
}

function isInspectionFinished(value: unknown): value is InspectionFinished {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.instanceId) &&
    (record.instanceId as number) > 0 &&
    (record.reason === 'animationend' || record.reason === 'hidden')
  );
}

function currentDisplaySettings(): DisplaySettings {
  return {
    inspectionDurationMs: appConfig.inspectionDurationMs,
    knifeDisplaySize: appConfig.knifeDisplaySize,
    offsetX: appConfig.offsetX,
    offsetY: appConfig.offsetY,
    smoothingLevel: appConfig.smoothingLevel,
    hideSystemCursor: appConfig.hideSystemCursor,
  };
}

function isSettingsSender(senderId: number): boolean {
  return (
    settingsWindow !== null &&
    !settingsWindow.isDestroyed() &&
    settingsWindow.webContents.id === senderId
  );
}

function sendDisplaySettingsToOverlays(): void {
  const settings = currentDisplaySettings();

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    overlay.window.webContents.send(IPC_CHANNELS.displaySettings, settings);
  }
}

function isSafeCustomSkinFileName(fileName: string): boolean {
  return (
    fileName.toLowerCase() === CUSTOM_SKIN_IDLE_FILENAME ||
    CUSTOM_SKIN_FRAME_PATTERN.test(fileName)
  );
}

function frameNumber(fileName: string): number {
  const match = CUSTOM_SKIN_FRAME_PATTERN.exec(fileName);
  return match === null ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
}

function customSkinUrl(fileName: string): string {
  return (
    `${CUSTOM_SKIN_SCHEME}://${CUSTOM_SKIN_HOST}/` +
    `${encodeURIComponent(fileName)}?v=${customSkinRevision}`
  );
}

function sameDirectory(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(path.resolve(a)) === normalize(path.resolve(b));
}

function inspectCustomSkinDirectory(directory: string): CustomSkinInspection {
  const resolved = path.resolve(directory);

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      logCrash(
        `[skin] inspect FAILED: not a directory path="${directory}" resolved="${resolved}"`,
      );
      return {
        ok: false,
        directory: resolved,
        frames: [],
        idleFile: null,
        error: '所选路径不是文件夹',
      };
    }

    const entries = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && CUSTOM_SKIN_FRAME_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((a, b) => {
        const delta = frameNumber(a) - frameNumber(b);
        return delta !== 0 ? delta : a.localeCompare(b);
      });

    if (entries.length === 0) {
      logCrash(
        `[skin] inspect FAILED: no frames path="${directory}" resolved="${resolved}"`,
      );
      return {
        ok: false,
        directory: resolved,
        frames: [],
        idleFile: null,
        error: '未找到有效的 frame_*.png 序列帧',
      };
    }

    const idleEntry = fs
      .readdirSync(resolved, { withFileTypes: true })
      .find(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase() === CUSTOM_SKIN_IDLE_FILENAME,
      );

    logCrash(
      `[skin] inspect OK resolved="${resolved}" frames=${entries.length} ` +
      `idle=${idleEntry?.name ?? '(none)'} ` +
      `first=${entries[0]} last=${entries[entries.length - 1]}`,
    );

    return {
      ok: true,
      directory: resolved,
      frames: entries,
      idleFile: idleEntry?.name ?? null,
      error: null,
    };
  } catch (error) {
    logCrash(
      `[skin] inspect CRASH path="${directory}" resolved="${resolved}" ` +
      `error=${describeError(error)}`,
    );
    return {
      ok: false,
      directory: resolved,
      frames: [],
      idleFile: null,
      error: `无法读取文件夹：${describeError(error)}`,
    };
  }
}

function currentSkinState(): SkinState {
  if (activeCustomSkin !== null) {
    return {
      mode: 'custom',
      customPath: appConfig.customSkinPath,
      frameCount: activeCustomSkin.frameCount,
      idleUrl: activeCustomSkin.idleUrl,
      frameUrls: [...activeCustomSkin.frameUrls],
      error: null,
    };
  }

  return {
    mode: 'builtin',
    customPath: appConfig.customSkinPath,
    frameCount: 0,
    idleUrl: null,
    frameUrls: [],
    error: customSkinError,
  };
}

function sendSkinToOverlays(): void {
  const skin = currentSkinState();

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    overlay.window.webContents.send(IPC_CHANNELS.skinChanged, skin);
  }
}

// ── V2.0 动作管理 ──

function actionSkinUrl(actionId: string, fileName: string, revision: number): string {
  // Revision is cached per action; bump it to force a reload after a folder change.
  return `${CUSTOM_SKIN_SCHEME}://${CUSTOM_SKIN_ACTION_HOST}/${encodeURIComponent(actionId)}/${encodeURIComponent(fileName)}?v=${revision}`;
}

/**
 * Scan a single action directory for frame_*.png files (plus optional idle.png).
 * This is a lightweight re-usable check; it does *not* load pixel data into
 * memory — the protocol handler streams files on demand.
 */
function inspectActionDirectory(directory: string): CustomSkinInspection {
  return inspectCustomSkinDirectory(directory);
}

/**
 * Validate an action directory and build a LoadedActionSkin. The frames are
 * returned as knife-asset://action/<id>/frame_NNN.png URLs so the renderer can
 * request them through the protocol handler without File:// CSP violations.
 */
function loadActionSkin(
  actionId: string,
  directory: string,
): LoadedActionSkin | null {
  const inspection = inspectActionDirectory(directory);
  if (!inspection.ok || inspection.frames.length === 0) {
    logCrash(
      `[action] skin scan FAILED actionId="${actionId}" ` +
      `directory="${directory}" resolved="${inspection.directory}" ` +
      `ok=${inspection.ok} frames=${inspection.frames.length} ` +
      `error="${inspection.error ?? '(none)'}"`,
    );
    console.warn(
      `[action] skin scan failed for action="${actionId}" dir="${directory}" error="${inspection.error}"`,
    );
    return null;
  }

  const revision = perActionRevisions.get(actionId) ?? 0;
  const idleFile = inspection.idleFile ?? inspection.frames[0];

  const skin: LoadedActionSkin = {
    actionId,
    directory: inspection.directory,
    idleUrl: actionSkinUrl(actionId, idleFile, revision),
    frameUrls: inspection.frames.map((fileName) =>
      actionSkinUrl(actionId, fileName, revision),
    ),
    frameCount: inspection.frames.length,
  };

  logCrash(
    `[action] skin loaded actionId="${actionId}" ` +
    `directory="${inspection.directory}" ` +
    `frames=${skin.frameCount} ` +
    `idleUrl="${skin.idleUrl.slice(0, 120)}" ` +
    `firstFrame="${skin.frameUrls[0]?.slice(0, 120) ?? '(none)'}" ` +
    `revision=${revision}`,
  );

  return skin;
}

function buildActiveActionData(
  actionId: string,
  source: 'uiohook' | 'fallback-shortcut',
): ActiveActionData | null {
  const mapping = actionMappings.find((a) => a.id === actionId);
  if (mapping === undefined) {
    return null;
  }

  const skin =
    perActionSkins.get(actionId) ?? null;

  // ── Merge per-action settings with global defaults ──
  const s = mapping.settings;
  const effectiveSettings: DisplaySettings = {
    inspectionDurationMs:
      s?.inspectionDurationMs ?? appConfig.inspectionDurationMs,
    knifeDisplaySize: s?.knifeDisplaySize ?? appConfig.knifeDisplaySize,
    offsetX: s?.offsetX ?? appConfig.offsetX,
    offsetY: s?.offsetY ?? appConfig.offsetY,
    smoothingLevel: s?.smoothingLevel ?? appConfig.smoothingLevel,
    hideSystemCursor: appConfig.hideSystemCursor,
  };

  return {
    actionId: skin?.actionId ?? actionId,
    actionName: mapping.name || path.basename(mapping.path),
    idleUrl: skin?.idleUrl ?? '',
    frameUrls: skin?.frameUrls ?? [],
    frameCount: skin?.frameCount ?? 0,
    effectiveSettings,
  };
}

function sendActiveActionToOverlays(data: ActiveActionData): void {
  let sent = 0;
  let errors = 0;

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    try {
      overlay.window.webContents.send(IPC_CHANNELS.actionActivated, data);
      sent++;
    } catch (error) {
      errors++;
      logCrash(
        `[action] sendActiveActionToOverlays IPC FAILED ` +
        `displayId=${overlay.displayId} actionId="${data.actionId}" ` +
        `error=${describeError(error)}`,
      );
      console.error(
        `[action] IPC send failed for display=${overlay.displayId}: ${describeError(error)}`,
      );
    }
  }

  if (sent === 0) {
    logCrash(
      `[action] sendActiveActionToOverlays: no overlays received ` +
      `actionId="${data.actionId}" frames=${data.frameCount} ` +
      `totalOverlays=${overlays.size}`,
    );
    console.warn(
      `[action] no overlays received action data actionId="${data.actionId}"`,
    );
  }
}

/**
 * Tell every overlay to switch back to the built-in (compiled-in) idle + frames.
 * Called ONLY from the Ctrl+Shift+Alt+F fallback shortcut handler so it always
 * shows the default art, never stale custom-action assets.
 *
 * IMPORTANT: this must NOT be called from `requestInspection` (the normal
 * action-key path).  Action keys already dispatch `sendActiveActionToOverlays`
 * inside `activateAction`, and an extra reset here would clobber the just-loaded
 * action art with the built-in frames.
 */
function sendResetToBuiltin(): void {
  sendActiveActionToOverlays({
    actionId: null,
    actionName: '(内置)',
    idleUrl: '',
    frameUrls: [],
    frameCount: 0,
    effectiveSettings: null, // renderer restores global defaults
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Idle animation helpers
// ═══════════════════════════════════════════════════════════════════

function sendIdleAnimationToOverlays(data: IdleAnimationData): void {
  let sent = 0;
  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    try {
      overlay.window.webContents.send(
        IPC_CHANNELS.idleAnimationChanged,
        data,
      );
      sent++;
    } catch (err) {
      console.error(
        `[idle] overlay send failed display=${overlay.displayId}: ${describeError(err)}`,
      );
    }
  }

  if (sent === 0) {
    console.warn('[idle] no overlays received idle animation data');
  }
}

function buildIdleAnimationData(
  actionId: string | null,
): IdleAnimationData {
  if (actionId === null || idleAnimationSkin === null) {
    return {
      actionId: null,
      actionName: null,
      frameUrls: [],
      idleStaticUrl: '',
      frameCount: 0,
      fps: IDLE_ANIMATION_FPS,
    };
  }

  return {
    actionId,
    actionName: idleAnimationSkin.actionName ?? null,
    frameUrls: idleAnimationSkin.frameUrls,
    idleStaticUrl: idleAnimationSkin.idleUrl,
    frameCount: idleAnimationSkin.frameCount,
    fps: IDLE_ANIMATION_FPS,
  };
}

/** Load the skin for an action and broadcast the idle animation data to overlays. */
function updateIdleAnimation(actionId: string | null): void {
  const previousSkinId = idleAnimationSkin?.actionId ?? null;

  // Clear cached skin when unsetting idle or switching to a different action.
  if (actionId === null || actionId !== previousSkinId) {
    idleAnimationSkin = null;
    idleAnimationSkinRevision = 0;
  }

  if (actionId === null) {
    idleActionId = null;
    sendIdleAnimationToOverlays(buildIdleAnimationData(null));
    return;
  }

  const mapping = actionMappings.find((a) => a.id === actionId);
  if (mapping === undefined) {
    console.warn(`[idle] action not found id="${actionId}"`);
    idleActionId = null;
    idleAnimationSkin = null;
    sendIdleAnimationToOverlays(buildIdleAnimationData(null));
    return;
  }

  // Load the skin on demand (or reuse cached).
  let skin: LoadedActionSkin | null | undefined = perActionSkins.get(actionId);
  if (skin === undefined && mapping.path.length > 0) {
    skin = loadActionSkin(actionId, mapping.path);
    if (skin !== null) {
      perActionSkins.set(actionId, skin);
    }
  }

  if (skin === null || skin === undefined) {
    console.warn(
      `[idle] skin unavailable for action="${mapping.name}" id=${actionId}`,
    );
    idleAnimationSkin = null;
    sendIdleAnimationToOverlays(buildIdleAnimationData(null));
    return;
  }

  idleAnimationSkin = { ...skin, actionName: mapping.name || path.basename(mapping.path), actionId };
  idleAnimationSkinRevision++;
  idleActionId = actionId;
  sendIdleAnimationToOverlays(buildIdleAnimationData(actionId));
  console.log(
    `[idle] animation set actionId="${actionId}" name="${mapping.name}" frames=${skin.frameCount}`,
  );
}

/** Find the first ActionMapping whose keycode & modifiers match the hook event. */
function findActionByKeycode(
  keycode: number,
  modifiers: number,
): ActionMapping | undefined {
  return actionMappings.find(
    (mapping) =>
      mapping.keycode === keycode && mapping.modifiers === modifiers,
  );
}

/**
 * Activate an action: load its skin on first use, build ActiveActionData and
 * send it to every overlay, then request an inspection from the renderer.
 *
 * Returns the ActionMapping or undefined if the action-id is not found.
 */
async function activateAction(
  actionId: string,
  source: 'uiohook' | 'fallback-shortcut',
): Promise<ActionMapping | undefined> {
  const mapping = actionMappings.find((a) => a.id === actionId);
  if (mapping === undefined) {
    logCrash(
      `[action] activate FAILED: mapping not found actionId="${actionId}" ` +
      `source=${source} knownIds=[${actionMappings.map((a) => a.id).join(',')}]`,
    );
    return undefined;
  }

  logCrash(
    `[action] activate BEGIN actionId="${actionId}" name="${mapping.name}" ` +
    `path="${mapping.path}" keycode=${mapping.keycode} source=${source} ` +
    `hasSkin=${perActionSkins.has(actionId)} ` +
    `isPackaged=${app.isPackaged}`,
  );

  // ── Load the skin on first use (lazy) ──
  if (!perActionSkins.has(actionId) && mapping.path.length > 0) {
    const skin = loadActionSkin(actionId, mapping.path);
    if (skin === null) {
      logCrash(
        `[action] activate SKIN FAILED action="${mapping.name}" id=${actionId} ` +
        `path="${mapping.path}"`,
      );
      console.warn(
        `[action] skin unavailable for action="${mapping.name}" id=${actionId} path=${mapping.path}`,
      );
      // Proceed without skin — renderer will display fallback SVG.
    } else {
      perActionSkins.set(actionId, skin);
      logCrash(
        `[action] skin loaded action="${mapping.name}" id=${actionId} ` +
        `frames=${skin.frameCount} idleUrl="${skin.idleUrl.slice(0, 100)}"`,
      );
      console.log(
        `[action] skin loaded action="${mapping.name}" id=${actionId} frames=${skin.frameCount}`,
      );
    }
  }

  // ── Build metadata and send ──
  const data = buildActiveActionData(actionId, source);
  if (data === null) {
    logCrash(
      `[action] activate FAILED: buildActiveActionData returned null ` +
      `actionId="${actionId}"`,
    );
    return undefined;
  }

  logCrash(
    `[action] activate SEND actionId="${actionId}" name="${data.actionName}" ` +
    `frames=${data.frameCount} idleUrl="${data.idleUrl.slice(0, 100)}" ` +
    `firstFrame="${data.frameUrls[0]?.slice(0, 100) ?? '(none)'}" ` +
    `actionSettings=${mapping.settings ? JSON.stringify(mapping.settings) : '(global)'}`,
  );

  activeActionId = actionId;
  sendActiveActionToOverlays(data);

  // ── Interrupt idle animation while inspecting ──
  if (idleActionId !== null) {
    sendIdleAnimationToOverlays({
      actionId: null,
      actionName: null,
      frameUrls: [],
      idleStaticUrl: '',
      frameCount: 0,
      fps: IDLE_ANIMATION_FPS,
    });
  }

  // ── Emit the inspection start ──
  const instanceId = ++inspectionSequence;
  requestInspection(source);
  console.log(
    `[action] activate id=${actionId} name="${data.actionName}" ` +
      `instance=${instanceId} source=${source} frames=${data.frameCount}`,
  );

  return mapping;
}

/** Drive uIOhook for the keycodes registered in actionMappings + the legacy F. */
function refreshActionHooks(): void {
  if (!uiohookStarted || uiohookModule === null) {
    return;
  }

  // uIOhook.start() does not accept a keycode list — it monitors every
  // keyboard event globally. Our dispatch function (handleHookKeyDown) already
  // compares event.keycode against each ActionMapping, so no restart is needed
  // here. We keep this function as a hook point in case per-key masking becomes
  // necessary in the future.
  logCrash(`Action hooks refreshed (${actionMappings.length} actions)`);
}

// ── 原有的皮肤管理（保持不变） ──

function loadCustomSkinFromConfig(): void {
  activeCustomSkin = null;
  customSkinError = null;
  customSkinRevision += 1;

  const configuredPath = appConfig.customSkinPath;
  if (configuredPath === null) {
    console.log('[skin] using built-in artwork');
    return;
  }

  const inspection = inspectCustomSkinDirectory(configuredPath);
  if (!inspection.ok || inspection.error !== null) {
    customSkinError =
      inspection.error ?? '自定义素材不可用，已回退内置素材';
    console.warn(
      `[skin] custom folder rejected path=${configuredPath}: ${customSkinError}`,
    );
    return;
  }

  const idleFile = inspection.idleFile ?? inspection.frames[0];
  activeCustomSkin = {
    directory: inspection.directory,
    idleUrl: customSkinUrl(idleFile),
    frameUrls: inspection.frames.map((fileName) => customSkinUrl(fileName)),
    frameCount: inspection.frames.length,
  };

  console.log(
    `[skin] custom artwork loaded path=${inspection.directory} ` +
      `frames=${inspection.frames.length} idle=${idleFile}`,
  );
}

let skinProtocolRegistered = false;

function registerCustomSkinProtocol(): void {
  if (skinProtocolRegistered) {
    return;
  }
  skinProtocolRegistered = true;

  protocol.handle(CUSTOM_SKIN_SCHEME, async (request) => {
    const start = performance.now();
    let filePath = '';
    let resolvedUrl = '';

    try {
      const parsed = new URL(request.url);

      // ── 原有自定义皮肤 ──
      if (parsed.hostname === CUSTOM_SKIN_HOST) {
        const fileName = decodeURIComponent(
          parsed.pathname.replace(/^\/+/, ''),
        );
        const skin = activeCustomSkin;

        if (
          skin === null ||
          !isSafeCustomSkinFileName(fileName)
        ) {
          return new Response('Not found', { status: 404 });
        }

        filePath = path.join(skin.directory, fileName);
        if (!fs.existsSync(filePath)) {
          logCrash(
            `[asset] custom-skin frame missing file="${filePath}" name="${fileName}" ` +
            `skinDir="${skin.directory}" url="${request.url}"`,
          );
          console.warn(
            `[asset] custom-skin frame missing file="${filePath}" name="${fileName}"`,
          );
          return new Response('Not found', { status: 404 });
        }

        resolvedUrl = pathToFileURL(filePath).toString();
        const response = await net.fetch(resolvedUrl);
        const ms = (performance.now() - start).toFixed(1);
        logCrash(
          `[asset] custom-skin OK file="${filePath}" status=${response.status} ` +
          `contentType=${response.headers.get('content-type') ?? '-'} ` +
          `size=${response.headers.get('content-length') ?? '-'} ` +
          `${ms}ms`,
        );
        return response;
      }

      // ── V2.0 动作皮肤（knife-asset://action/<id>/filename.png）─
      if (parsed.hostname === CUSTOM_SKIN_ACTION_HOST) {
        const parts = parsed.pathname.replace(/^\/+/, '').split('/');
        if (parts.length < 2) {
          logCrash(
            `[asset] action malformed url="${request.url}" parts=${parts.length}`,
          );
          return new Response('Not found', { status: 404 });
        }

        const actionId = decodeURIComponent(parts[0]);
        const fileName = decodeURIComponent(parts.slice(1).join('/'));
        const skin = perActionSkins.get(actionId);

        if (skin === undefined) {
          logCrash(
            `[asset] action not loaded actionId="${actionId}" fileName="${fileName}" ` +
            `url="${request.url}" loadedActions=[${[...perActionSkins.keys()].join(',')}]`,
          );
          console.warn(
            `[asset] action not loaded actionId="${actionId}" fileName="${fileName}"`,
          );
          return new Response('Not found', { status: 404 });
        }

        if (!isSafeCustomSkinFileName(fileName)) {
          logCrash(
            `[asset] action unsafe filename actionId="${actionId}" fileName="${fileName}"`,
          );
          return new Response('Not found', { status: 404 });
        }

        filePath = path.join(skin.directory, fileName);

        // Sanity check: the resolved path must stay inside the skin directory.
        const resolvedDir = path.resolve(skin.directory);
        const resolvedFile = path.resolve(filePath);
        if (
          !resolvedFile.startsWith(resolvedDir + path.sep) &&
          resolvedFile !== resolvedDir
        ) {
          logCrash(
            `[asset] action path-escape attempt actionId="${actionId}" ` +
            `fileName="${fileName}" filePath="${filePath}" ` +
            `skinDir="${resolvedDir}"`,
          );
          console.warn(
            `[asset] action path-escape blocked actionId="${actionId}" ` +
            `fileName="${fileName}"`,
          );
          return new Response('Not found', { status: 403 });
        }

        if (!fs.existsSync(filePath)) {
          logCrash(
            `[asset] action frame missing actionId="${actionId}" fileName="${fileName}" ` +
            `filePath="${filePath}" skinDir="${skin.directory}" url="${request.url}"`,
          );
          console.warn(
            `[asset] action frame missing action="${skin.actionId}" file="${fileName}"`,
          );
          return new Response('Not found', { status: 404 });
        }

        resolvedUrl = pathToFileURL(filePath).toString();
        const response = await net.fetch(resolvedUrl);
        const ms = (performance.now() - start).toFixed(1);

        if (response.status !== 200) {
          logCrash(
            `[asset] action fetch FAILED actionId="${actionId}" fileName="${fileName}" ` +
            `filePath="${filePath}" resolvedUrl="${resolvedUrl}" ` +
            `status=${response.status} ${ms}ms`,
          );
        }

        return response;
      }

      logCrash(
        `[asset] unknown host hostname="${parsed.hostname}" url="${request.url}"`,
      );
      return new Response('Not found', { status: 404 });
    } catch (error) {
      const detail = describeError(error);
      logCrash(
        `[asset] protocol handler CRASH url="${request.url}" ` +
        `filePath="${filePath}" resolvedUrl="${resolvedUrl}" ` +
        `error=${detail}`,
      );
      console.error(`[asset] protocol handler error: ${detail}`);
      return new Response('Asset error', { status: 500 });
    }
  });
}

function setCustomSkin(directory: string | null): SkinSelectionResult {
  const previousPath = appConfig.customSkinPath;
  const previousMode = activeCustomSkin === null ? 'builtin' : 'custom';

  if (directory === null) {
    appConfig = { ...appConfig, customSkinPath: null };
    activeCustomSkin = null;
    customSkinError = null;
    customSkinRevision += 1;
  } else {
    const inspection = inspectCustomSkinDirectory(directory);
    if (!inspection.ok || inspection.error !== null) {
      return {
        path: null,
        canceled: false,
        changed: false,
        error: inspection.error ?? '未找到有效的 frame_*.png 序列帧',
        skin: currentSkinState(),
      };
    }

    appConfig = { ...appConfig, customSkinPath: inspection.directory };
    activeCustomSkin = null;
    customSkinError = null;
    customSkinRevision += 1;

    const idleFile = inspection.idleFile ?? inspection.frames[0];
    activeCustomSkin = {
      directory: inspection.directory,
      idleUrl: customSkinUrl(idleFile),
      frameUrls: inspection.frames.map((fileName) => customSkinUrl(fileName)),
      frameCount: inspection.frames.length,
    };
  }

  const changed =
    previousPath !== appConfig.customSkinPath ||
    previousMode !== (activeCustomSkin === null ? 'builtin' : 'custom');

  persistAppConfig('custom-skin');
  sendSkinToOverlays();

  console.log(
    `[skin] changed mode=${activeCustomSkin === null ? 'builtin' : 'custom'} ` +
      `path=${appConfig.customSkinPath ?? '(none)'} changed=${changed}`,
  );

  return {
    path: appConfig.customSkinPath,
    canceled: false,
    changed,
    error: null,
    skin: currentSkinState(),
  };
}

async function chooseCustomSkin(): Promise<SkinSelectionResult> {
  const owner = settingsWindow;
  if (owner === null || owner.isDestroyed()) {
    return {
      path: null,
      canceled: true,
      changed: false,
      error: '设置窗口不可用',
      skin: currentSkinState(),
    };
  }

  const selection = await dialog.showOpenDialog(owner, {
    title: '选择蝴蝶刀素材文件夹',
    buttonLabel: '使用此文件夹',
    properties: ['openDirectory'],
  });

  if (selection.canceled || selection.filePaths.length === 0) {
    return {
      path: null,
      canceled: true,
      changed: false,
      error: null,
      skin: currentSkinState(),
    };
  }

  const inspection = inspectCustomSkinDirectory(selection.filePaths[0]);
  if (!inspection.ok || inspection.error !== null) {
    const message = inspection.error ?? '未找到有效的 frame_*.png 序列帧';
    await dialog.showMessageBox(owner, {
      type: 'warning',
      title: '素材文件夹无效',
      message: '未找到有效的 frame_*.png 序列帧',
      detail: `${message}\n\n请选择包含 frame_000.png、frame_001.png … 的文件夹。当前素材未改变。`,
      buttons: ['知道了'],
      noLink: true,
    });

    return {
      path: null,
      canceled: false,
      changed: false,
      error: message,
      skin: currentSkinState(),
    };
  }

  const result = setCustomSkin(inspection.directory);
  if (result.changed) {
    console.log(
      `[skin] selected path=${inspection.directory} frames=${inspection.frames.length}`,
    );
  }

  return result;
}

function resetCustomSkin(): SkinSelectionResult {
  return setCustomSkin(null);
}

function updateDisplaySettings(patch: unknown): DisplaySettings {
  if (typeof patch !== 'object' || patch === null) {
    throw new Error('invalid settings payload');
  }

  const record = patch as Record<string, unknown>;
  let nextDuration = appConfig.inspectionDurationMs;
  let nextSize = appConfig.knifeDisplaySize;
  let nextOffsetX = appConfig.offsetX;
  let nextOffsetY = appConfig.offsetY;
  let nextSmoothingLevel = appConfig.smoothingLevel;
  let nextHideSystemCursor = appConfig.hideSystemCursor;

  if ('inspectionDurationMs' in record) {
    if (
      typeof record.inspectionDurationMs !== 'number' ||
      !Number.isFinite(record.inspectionDurationMs)
    ) {
      throw new Error('inspectionDurationMs must be a finite number');
    }
    nextDuration = normalizeInspectionDuration(record.inspectionDurationMs);
  }

  if ('knifeDisplaySize' in record) {
    if (
      typeof record.knifeDisplaySize !== 'number' ||
      !Number.isFinite(record.knifeDisplaySize)
    ) {
      throw new Error('knifeDisplaySize must be a finite number');
    }
    nextSize = normalizeKnifeDisplaySize(record.knifeDisplaySize);
  }

  if ('offsetX' in record) {
    if (
      typeof record.offsetX !== 'number' ||
      !Number.isFinite(record.offsetX)
    ) {
      throw new Error('offsetX must be a finite number');
    }
    nextOffsetX = normalizeOffset(record.offsetX);
  }

  if ('offsetY' in record) {
    if (
      typeof record.offsetY !== 'number' ||
      !Number.isFinite(record.offsetY)
    ) {
      throw new Error('offsetY must be a finite number');
    }
    nextOffsetY = normalizeOffset(record.offsetY);
  }

  if ('smoothingLevel' in record) {
    if (
      typeof record.smoothingLevel !== 'number' ||
      !Number.isFinite(record.smoothingLevel)
    ) {
      throw new Error('smoothingLevel must be a finite number');
    }
    nextSmoothingLevel = normalizeSmoothingLevel(record.smoothingLevel);
  }

  if ('hideSystemCursor' in record) {
    if (typeof record.hideSystemCursor !== 'boolean') {
      throw new Error('hideSystemCursor must be a boolean');
    }
    nextHideSystemCursor = record.hideSystemCursor;
  }

  const durationChanged = nextDuration !== appConfig.inspectionDurationMs;
  const sizeChanged = nextSize !== appConfig.knifeDisplaySize;
  const offsetChanged =
    nextOffsetX !== appConfig.offsetX || nextOffsetY !== appConfig.offsetY;
  const smoothingChanged = nextSmoothingLevel !== appConfig.smoothingLevel;
  const hideChanged = nextHideSystemCursor !== appConfig.hideSystemCursor;

  if (
    !durationChanged &&
    !sizeChanged &&
    !offsetChanged &&
    !smoothingChanged &&
    !hideChanged
  ) {
    return currentDisplaySettings();
  }

  appConfig = {
    ...appConfig,
    inspectionDurationMs: nextDuration,
    knifeDisplaySize: nextSize,
    offsetX: nextOffsetX,
    offsetY: nextOffsetY,
    smoothingLevel: nextSmoothingLevel,
    hideSystemCursor: nextHideSystemCursor,
  };

  if (sizeChanged || offsetChanged || smoothingChanged) {
    // Reposition every loaded overlay immediately. Size, hotspot offset and
    // cursor damping are all applied by the renderer around the cursor point.
    sendDisplaySettingsToOverlays();
  }

  if (hideChanged) {
    if (nextHideSystemCursor) {
      // Apply immediately, including while the settings window is open. The
      // overlay stays above it and acts as the pointer, so the controls remain
      // usable even though the Windows arrow is hidden.
      void startSystemCursorHider('settings-toggle-on');
    } else {
      // Kill the helper first, then restore, so a hung SetSystemCursor call
      // cannot put the blank handle back after our restore. Unconditional.
      void stopSystemCursorHider('settings-toggle-off');
    }
  }

  console.log(
    `[settings] duration=${nextDuration}ms size=${nextSize}px ` +
      `offset=${nextOffsetX},${nextOffsetY} smoothing=${nextSmoothingLevel} ` +
      `hideCursor=${nextHideSystemCursor} ` +
      `activeInspection=${activeInspectionId !== 0 ? activeInspectionId : 'none'}`,
  );

  schedulePersistAppConfig(
    `settings duration=${nextDuration}ms size=${nextSize}px ` +
      `offset=${nextOffsetX},${nextOffsetY} ` +
      `smoothing=${nextSmoothingLevel} hideCursor=${nextHideSystemCursor}`,
  );
  refreshTrayMenu();

  return currentDisplaySettings();
}

// ── V2.0 动作 IPC 辅助函数 ──

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Scan `rootPath` for immediate subdirectories that contain at least one
 * frame_*.png. Also checks whether `rootPath` **itself** directly contains
 * frame_*.png files — when the user selects a single action folder instead
 * of a parent with subfolders, treat it as a one-candidate scan.
 *
 * This is a cheap metadata scan — absolutely no pixel data is loaded here.
 */
function performActionScan(rootPath: string): ActionScanResult {
  const resolved = path.resolve(rootPath);

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        rootPath: resolved,
        candidates: [],
        error: '所选路径不是文件夹',
      };
    }

    // ── 第一步：检查选定目录自身是否直接包含 frame_*.png ──
    // 如果用户直接选了 movement_1（而不是它的父目录），就把它当作
    // 一个单独的动作。
    try {
      const selfHasFrames = fs
        .readdirSync(resolved, { withFileTypes: true })
        .some((e) => e.isFile() && CUSTOM_SKIN_FRAME_PATTERN.test(e.name));

      if (selfHasFrames) {
        // Use the directory basename as the action name.
        return {
          ok: true,
          rootPath: path.dirname(resolved),
          candidates: [path.basename(resolved)],
          error: null,
        };
      }
    } catch {
      // If readdir fails on the root itself, fall through to subfolder scan.
    }

    // ── 第二步：遍历子文件夹 ──
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const candidates: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const subDir = path.join(resolved, entry.name);

      let frameFile: fs.Dirent | undefined;
      try {
        frameFile = fs
          .readdirSync(subDir, { withFileTypes: true })
          .find((e) => e.isFile() && CUSTOM_SKIN_FRAME_PATTERN.test(e.name));
      } catch {
        // Permission error, broken symlink, etc. — skip this subfolder.
        console.warn(
          `[action] scan skipping unreadable subfolder "${entry.name}"`,
        );
        continue;
      }

      if (frameFile === undefined) {
        continue;
      }

      candidates.push(entry.name);
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        rootPath: resolved,
        candidates: [],
        error: '未找到包含 frame_*.png 的子文件夹',
      };
    }

    return {
      ok: true,
      rootPath: resolved,
      candidates,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      rootPath: resolved,
      candidates: [],
      error: `无法读取文件夹：${describeError(error)}`,
    };
  }
}

/**
 * Keep appConfig.actionMappings in sync with the runtime array so
 * persistAppConfig writes the latest state.
 */
function syncActionMappingsToConfig(): void {
  appConfig.actionMappings = [...actionMappings];
}

/**
 * Create or update an ActionMapping.
 *
 * When `id` is null a new mapping is created (allocating a fresh uuid).
 * When `id` matches an existing mapping the given fields are merged.
 *
 * Invalid fields are silently dropped so a hand-edited config.json fails safe.
 * **Ghost-entry guard**: if `id` is provided but does not exist in the
 * runtime array the call is REJECTED with an error.  Callers (settings.ts)
 * must use the id returned from a previous successful setAction call.
 */
function setActionMapping(
  id: string | null,
  partial: Record<string, unknown>,
): { ok: boolean; mapping?: ActionMapping; error?: string } {
  // ── Guard: reject unknown non-null ids ──
  if (id !== null && !actionMappings.some((a) => a.id === id)) {
    return { ok: false, error: `动作 id 不存在：${id}` };
  }

  const existingIndex =
    id !== null ? actionMappings.findIndex((a) => a.id === id) : -1;

  const base: ActionMapping =
    existingIndex >= 0
      ? { ...actionMappings[existingIndex] }
      : {
          id: generateActionId(),
          name: '',
          path: '',
          keycode: 0,
          keyName: '',
          modifiers: 0,
        };

  const name = isStringField(partial, 'name');
  const dirPath = isStringField(partial, 'path');
  const keycode =
    typeof partial.keycode === 'number' && Number.isFinite(partial.keycode)
      ? Math.round(partial.keycode)
      : undefined;
  const keyName = isStringField(partial, 'keyName');
  const modifiers =
    typeof partial.modifiers === 'number' && Number.isFinite(partial.modifiers)
      ? Math.max(0, Math.round(partial.modifiers))
      : undefined;

  // ── Per-action settings (optional override for size / duration / offset / smoothing) ──
  let actionSettings: ActionSettings | undefined;
  if (isPlainRecord(partial.settings)) {
    const raw = partial.settings as Record<string, unknown>;
    actionSettings = {};
    if (
      typeof raw.inspectionDurationMs === 'number' &&
      Number.isFinite(raw.inspectionDurationMs)
    ) {
      actionSettings.inspectionDurationMs =
        normalizeInspectionDuration(raw.inspectionDurationMs);
    }
    if (
      typeof raw.knifeDisplaySize === 'number' &&
      Number.isFinite(raw.knifeDisplaySize)
    ) {
      actionSettings.knifeDisplaySize =
        normalizeKnifeDisplaySize(raw.knifeDisplaySize);
    }
    if (typeof raw.offsetX === 'number' && Number.isFinite(raw.offsetX)) {
      actionSettings.offsetX = normalizeOffset(raw.offsetX);
    }
    if (typeof raw.offsetY === 'number' && Number.isFinite(raw.offsetY)) {
      actionSettings.offsetY = normalizeOffset(raw.offsetY);
    }
    if (
      typeof raw.smoothingLevel === 'number' &&
      Number.isFinite(raw.smoothingLevel)
    ) {
      actionSettings.smoothingLevel =
        normalizeSmoothingLevel(raw.smoothingLevel);
    }
    // Drop empty settings objects so we don't persist noise.
    if (Object.keys(actionSettings).length === 0) {
      actionSettings = undefined;
    }
  }

  const settingsProvided = isPlainRecord(partial.settings);

  if (dirPath !== undefined) {
    const inspection = inspectActionDirectory(dirPath);
    if (!inspection.ok) {
      return { ok: false, error: inspection.error ?? '无效的动作目录' };
    }
  }

  const updated: ActionMapping = {
    ...base,
    name: name ?? base.name,
    path: dirPath ?? base.path,
    keycode: keycode ?? base.keycode,
    keyName: keyName ?? base.keyName,
    modifiers: modifiers ?? base.modifiers,
    settings: settingsProvided
      ? actionSettings // may be undefined (explicit clear)
      : base.settings, // keep existing when field not provided
  };

  // ── Guard: reject entries with empty name or path ──
  // A ghost entry (name='' / path='') breaks the renderer and creates
  // 404 loops inside the knife-asset:// protocol handler.
  if (updated.name.trim().length === 0 || updated.path.trim().length === 0) {
    return { ok: false, error: '动作名和路径均不能为空' };
  }

  // ── Guard: reject duplicate paths (case-insensitive on Windows) ──
  const normalizedPath = updated.path.replace(/[/\\]+$/, '').toLowerCase();
  for (const existing of actionMappings) {
    if (existing.id === updated.id) {
      continue;
    }
    if (
      existing.path.replace(/[/\\]+$/, '').toLowerCase() === normalizedPath
    ) {
      return {
        ok: false,
        error: `路径已被“${existing.name || existing.path}”引用，不能重复添加同一个文件夹。`,
      };
    }
  }

  // When the directory changes, invalidate the cached skin so the next
  // activateAction() call will reload.
  if (dirPath !== undefined && dirPath !== base.path) {
    perActionSkins.delete(updated.id);
    const nextRev = (perActionRevisions.get(updated.id) ?? 0) + 1;
    perActionRevisions.set(updated.id, nextRev);
  }

  if (existingIndex >= 0) {
    actionMappings[existingIndex] = updated;
  } else {
    actionMappings.push(updated);
  }

  actionRootDirectory = null; // reset; explicit scan via settings picks next
  syncActionMappingsToConfig();
  schedulePersistAppConfig('actionSet');
  return { ok: true, mapping: updated };
}

function removeActionMapping(id: string): boolean {
  const index = actionMappings.findIndex((a) => a.id === id);
  if (index === -1) {
    return false;
  }

  // If the removed action is currently active, reset to idle.
  if (activeActionId === id) {
    activeActionId = null;
    forceIdle('action-removed');
  }

  // If the removed action was the idle animation, unset idle.
  if (idleActionId === id) {
    updateIdleAnimation(null);
  }

  perActionSkins.delete(id);
  perActionRevisions.delete(id);
  actionMappings.splice(index, 1);
  syncActionMappingsToConfig();
  schedulePersistAppConfig('actionRemove');
  return true;
}

function registerIpcHandlers(): void {
  ipcMain.on(IPC_CHANNELS.inspectionFinished, (event, payload: unknown) => {
    if (!isInspectionFinished(payload)) {
      return;
    }

    const senderId = event.sender.id;
    const senderIsOverlay = [...overlays.values()].some(
      (overlay) =>
        !overlay.window.isDestroyed() &&
        overlay.window.webContents.id === senderId,
    );

    if (!senderIsOverlay) {
      return;
    }

    if (payload.instanceId !== activeInspectionId) {
      console.log(
        `[inspect] ignored finish instance=${payload.instanceId} ` +
          `current=${activeInspectionId}`,
      );
      return;
    }

    activeInspectionId = 0;
    clearInspectionSafetyTimer();
    console.log(
      `[inspect] finished instance=${payload.instanceId} reason=${payload.reason}`,
    );

    // Restore idle animation after inspection completes.
    if (idleActionId !== null && !appConfig.overlayEnabled === false) {
      sendIdleAnimationToOverlays(buildIdleAnimationData(idleActionId));
    }
  });

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return currentDisplaySettings();
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (event, patch: unknown) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return updateDisplaySettings(patch);
  });

  ipcMain.handle(IPC_CHANNELS.skinGet, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return currentSkinState();
  });

  ipcMain.handle(IPC_CHANNELS.skinChoose, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return chooseCustomSkin();
  });

  ipcMain.handle(IPC_CHANNELS.skinReset, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return resetCustomSkin();
  });

  // ── V2.0 动作管理 IPC ──

  ipcMain.handle(IPC_CHANNELS.actionsList, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return [...actionMappings];
  });

  ipcMain.handle(
    IPC_CHANNELS.actionsScan,
    (event, rootPath: unknown) => {
      if (!isSettingsSender(event.sender.id)) {
        throw new Error('settings IPC is only available to the settings window');
      }

      if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
        return {
          ok: false,
          directory: String(rootPath ?? ''),
          entries: [],
          error: '路径无效',
        };
      }

      return performActionScan(rootPath.trim());
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.actionsSet,
    (event, partial: unknown) => {
      if (!isSettingsSender(event.sender.id)) {
        throw new Error('settings IPC is only available to the settings window');
      }

      if (!isPlainRecord(partial)) {
        throw new Error('actionsSet expects an object');
      }

      return setActionMapping(
        isStringField(partial, 'id') ?? null,
        partial,
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.actionsRemove, (event, id: unknown) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('actionsRemove requires a valid action id');
    }

    return removeActionMapping(id);
  });

  ipcMain.handle(IPC_CHANNELS.actionsChooseRoot, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    const sender = BrowserWindow.fromWebContents(event.sender);
    if (sender === null) {
      return null;
    }

    const result = dialog.showOpenDialogSync(sender, {
      title: '选择动作根目录',
      properties: ['openDirectory', 'dontAddToRecent'],
    });

    if (result === undefined || result.length === 0) {
      return null;
    }

    return result[0];
  });

  // ── 按键录制（主进程 uiohook 捕获）──
  ipcMain.handle(
    IPC_CHANNELS.actionsStartRecording,
    (event, actionId: unknown) => {
      if (!isSettingsSender(event.sender.id)) {
        throw new Error('settings IPC is only available to the settings window');
      }

      if (typeof actionId !== 'string' || actionId.length === 0) {
        throw new Error('actionsStartRecording requires a valid action id');
      }

      // Cancel any previous recording in flight.
      settingsRecordingActionId = null;

      // Arm recording mode; handleHookKeyDown will pick up the next
      // non-modifier keydown event.
      settingsRecordingActionId = actionId;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.actionsCancelRecording,
    (event) => {
      if (!isSettingsSender(event.sender.id)) {
        throw new Error('settings IPC is only available to the settings window');
      }

      settingsRecordingActionId = null;
    },
  );

  // ── 恢复出厂设置 ──
  ipcMain.handle(IPC_CHANNELS.actionsReset, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    try {
      resetAppConfig();
      return true;
    } catch (error) {
      console.error(
        `[config] factory reset failed: ${describeError(error)}`,
      );
      logCrash(
        `[config] factory reset failed: ${describeError(error)}`,
      );
      return false;
    }
  });

  // ── 待机循环动画 ──
  ipcMain.handle(IPC_CHANNELS.actionsSetIdle, (event, actionId: unknown) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    try {
      const id =
        typeof actionId === 'string' && actionId.length > 0 ? actionId : null;
      updateIdleAnimation(id);
      // Persist idleActionId to config.
      syncActionMappingsToConfig();
      schedulePersistAppConfig('idleAction');
      return { ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logCrash('actionsSetIdle', 'UNCAUGHT', { message, actionId });
      return { ok: false as const, error: message };
    }
  });
}

function clearInspectionSafetyTimer(): void {
  if (inspectionSafetyTimer === null) {
    return;
  }

  clearTimeout(inspectionSafetyTimer);
  inspectionSafetyTimer = null;
}

function hasLoadedOverlay(): boolean {
  for (const overlay of overlays.values()) {
    if (!overlay.window.isDestroyed() && overlay.loaded) {
      return true;
    }
  }

  return false;
}

function sendInspectionStart(start: InspectionStart): number {
  let sent = 0;

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    overlay.window.webContents.send(IPC_CHANNELS.inspectionStart, start);
    sent += 1;
  }

  return sent;
}

function sendInspectionReset(reset: InspectionReset): number {
  let sent = 0;

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    overlay.window.webContents.send(IPC_CHANNELS.inspectionReset, reset);
    sent += 1;
  }

  return sent;
}

function requestInspection(source: string): void {
  if (!overlayVisible || quitting) {
    return;
  }

  if (!hasLoadedOverlay()) {
    console.warn(`[inspect] ignored trigger source=${source}: window not loaded`);
    return;
  }

  const now = Date.now();

  if (activeInspectionId !== 0) {
    if (appConfig.retriggerMode === 'ignore') {
      console.log(`[inspect] ignored trigger source=${source} mode=ignore`);
      return;
    }

    if (now - lastInspectionStartedAt < MIN_RETRIGGER_INTERVAL_MS) {
      console.log(`[inspect] ignored restart inside 50ms source=${source}`);
      return;
    }
  }

  inspectionSequence += 1;
  const instanceId = inspectionSequence;
  activeInspectionId = instanceId;
  lastInspectionStartedAt = now;

  // ── Per-action duration override ──
  const actionMapping =
    activeActionId !== null
      ? actionMappings.find((a) => a.id === activeActionId)
      : undefined;
  const durationMs =
    actionMapping?.settings?.inspectionDurationMs ??
    appConfig.inspectionDurationMs;

  const sent = sendInspectionStart({
    instanceId,
    durationMs,
    retriggerMode: appConfig.retriggerMode,
  });

  if (sent === 0) {
    activeInspectionId = 0;
    return;
  }

  clearInspectionSafetyTimer();
  inspectionSafetyTimer = setTimeout(() => {
    inspectionSafetyTimer = null;
    if (activeInspectionId === instanceId) {
      console.warn(`[inspect] safety timeout instance=${instanceId}`);
      forceIdle('inspection-safety-timeout');
    }
  }, durationMs + INSPECTION_SAFETY_MARGIN_MS);

  console.log(
    `[inspect] start instance=${instanceId} source=${source} ` +
      `mode=${appConfig.retriggerMode} duration=${durationMs}ms windows=${sent}`,
  );
}

function forceIdle(reason: string): void {
  const hadActiveInspection = activeInspectionId !== 0;
  activeActionKeys.clear();
  activeInspectionId = 0;
  clearInspectionSafetyTimer();

  inspectionSequence += 1;
  const sent = sendInspectionReset({
    instanceId: inspectionSequence,
    reason,
  });

  console.log(
    `[inspect] force idle reason=${reason} hadActive=${hadActiveInspection} ` +
      `windows=${sent}`,
  );
}

// ── V2.0 per-key lock map ──
// key: uiohook keycode, value: true while that key is held.
const activeActionKeys = new Set<number>();

function handleHookKeyDown(event: HookKeyEvent): void {
  console.log(`[hook] keydown=${event.keycode}`);

  // ── 按键录制模式（设置窗口录键）──
  if (settingsRecordingActionId !== null) {
    const recordingActionId = settingsRecordingActionId;

    // Left/Right Ctrl (29) / Shift (42,54) / Alt (56) / Win are modifiers;
    // Esc (1) cancels recording — handled in the main IPC handler below.
    if (event.keycode === 1 /* Esc */) {
      // Let the IPC handler deal with cancellation.
      return;
    }

    if (event.keycode === 29 || event.keycode === 42 || event.keycode === 54 || event.keycode === 56) {
      // Pure modifier press — only record when a non-modifier key comes next.
      return;
    }

    // Consume this key as the recorded key — exit recording mode first so
    // the settings window callback can issue setAction without deadlocks.
    settingsRecordingActionId = null;

    const keyName = uiohookKeyName(event.keycode);

    if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send(IPC_CHANNELS.actionKeyRecorded, {
        actionId: recordingActionId,
        keycode: event.keycode,
        keyName,
      } satisfies ActionKeyRecorded);
    }

    return; // Do not dispatch normal action/inspection while recording.
  }

  // Win, Alt+Tab and other shell shortcuts open topmost shell windows after
  // the key event. Raise immediately and once more after the shell paints.
  nudgeOverlayZOrder('global-keydown');

  // ── V2.0 动作分发 ──
  const actionMapping =
    actionMappings.length > 0
      ? findActionByKeycode(event.keycode, 0 /* modifiers unavailable in this hook event interface */)
      : undefined;

  if (actionMapping !== undefined) {
    if (activeActionKeys.has(event.keycode)) {
      // Key already held; OS auto-repeat — ignore.
      return;
    }

    activeActionKeys.add(event.keycode);
    void activateAction(actionMapping.id, 'uiohook');
    return;
  }

  // No matching action → ignore this key completely.
  // (Ctrl+Shift+Alt+F still works via globalShortcut in registerShortcuts.)
}

function handleHookKeyUp(event: HookKeyEvent): void {
  activeActionKeys.delete(event.keycode);

  if (actionMappings.some((mapping) => mapping.keycode === event.keycode)) {
    console.log(`[hook] action keyup keycode=${event.keycode} (unlocked)`);
  }
}

function handleHookMouseDown(_event: HookMouseEvent): void {
  // Clicking the Start button / search box opens a shell window after this
  // event. The delayed retry in nudgeOverlayZOrder covers that paint.
  nudgeOverlayZOrder('global-mousedown');
}

function startKeyboardHook(): void {
  if (uiohookStarted || quitting) {
    return;
  }

  if (DISABLE_HOOK_FOR_DIAGNOSTICS) {
    uiohookError = 'disabled by KNIFE_CURSOR_DISABLE_HOOK=1';
    logCrash('Keyboard hook skipped by KNIFE_CURSOR_DISABLE_HOOK=1');
    refreshTrayMenu();
    return;
  }

  try {
    logCrash('Keyboard hook: requiring uiohook-napi');
    const module =
      uiohookModule ??
      (require('uiohook-napi') as UiohookModule);

    uiohookModule = module;
    logCrash('Keyboard hook: module loaded; attaching listeners');

    if (!uiohookListenersAttached) {
      module.uIOhook.on('keydown', handleHookKeyDown);
      module.uIOhook.on('keyup', handleHookKeyUp);
      module.uIOhook.on('mousedown', handleHookMouseDown);
      uiohookListenersAttached = true;
    }

    logCrash('Keyboard hook: calling uIOhook.start()');
    module.uIOhook.start();
    uiohookStarted = true;
    uiohookError = null;
    uiohookErrorShown = false;
    console.log(`[hook] uiohook started F=${F_KEYCODE}`);
    logCrash('Keyboard hook: uIOhook.start() returned');
    refreshTrayMenu();
  } catch (error) {
    const message = describeError(error);
    uiohookError = message;
    console.error('[hook] uiohook start failed', error);
    logCrash(`Keyboard hook start failed: ${message}`);
    refreshTrayMenu();

    if (!uiohookErrorShown) {
      uiohookErrorShown = true;
      dialog.showErrorBox(
        '全局键盘钩子启动失败',
        `无法启动 uiohook-napi。\n\n${message}\n\n` +
          `仍可使用 ${FALLBACK_TRIGGER_SHORTCUT} 触发检视，` +
          `托盘菜单和 ${EMERGENCY_QUIT_SHORTCUT} 退出仍然可用。`,
      );
    }
  }
}

function stopKeyboardHook(): void {
  if (!uiohookStarted || uiohookModule === null) {
    return;
  }

  try {
    uiohookModule.uIOhook.stop();
  } catch (error) {
    console.warn('[hook] uiohook stop failed', error);
  }

  if (uiohookListenersAttached) {
    try {
      uiohookModule.uIOhook.off('keydown', handleHookKeyDown);
      uiohookModule.uIOhook.off('keyup', handleHookKeyUp);
    } catch (error) {
      console.warn('[hook] remove listeners failed', error);
    }
    uiohookListenersAttached = false;
  }

  uiohookStarted = false;
}

function restartKeyboardHook(reason: string): void {
  console.log(`[hook] restarting reason=${reason}`);
  stopKeyboardHook();
  startKeyboardHook();
}

function registerPowerEvents(): void {
  powerMonitor.on('lock-screen', () => {
    console.log('[power] lock-screen');
    forceIdle('lock-screen');
    // Do not leave the secure/lock desktop without a pointer.
    void stopSystemCursorHider('lock-screen');
  });

  powerMonitor.on('unlock-screen', () => {
    console.log('[power] unlock-screen');
    forceIdle('unlock-screen');
    restartKeyboardHook('unlock-screen');
    void startSystemCursorHider('unlock-screen');
  });

  powerMonitor.on('suspend', () => {
    console.log('[power] suspend');
    forceIdle('suspend');
    void stopSystemCursorHider('suspend');
  });

  powerMonitor.on('resume', () => {
    console.log('[power] resume');
    forceIdle('resume');
    restartKeyboardHook('resume');
    void startSystemCursorHider('resume');
  });
}

function registerShortcuts(): void {
  const register = (
    accelerator: string,
    label: string,
    handler: () => void,
  ): void => {
    try {
      if (!globalShortcut.register(accelerator, handler)) {
        console.error(`[shortcut] could not register ${accelerator} (${label})`);
        return;
      }

      console.log(`[shortcut] registered ${accelerator} (${label})`);
    } catch (error) {
      console.error(`[shortcut] registration failed ${accelerator}`, error);
    }
  };

  for (const shortcut of RETRIGGER_MODE_SHORTCUTS) {
    register(shortcut.accelerator, `retriggerMode=${shortcut.mode}`, () => {
      setRetriggerMode(shortcut.mode);
    });
  }

  register(OVERLAY_TOGGLE_SHORTCUT, 'toggle overlay', () => {
    setOverlayEnabled(!overlayVisible);
  });

  register(FALLBACK_TRIGGER_SHORTCUT, 'fallback inspection', () => {
    // Reset to built-in assets BEFORE requesting inspection, so the
    // Ctrl+Shift+Alt+F shortcut always plays the default art regardless
    // of which custom action was last active.
    sendResetToBuiltin();
    requestInspection('fallback-shortcut');
  });

  register(FORCE_CURSOR_RESTORE_SHORTCUT, 'force cursor restore', () => {
    forceRestoreSystemCursor();
  });

  register(EMERGENCY_QUIT_SHORTCUT, 'emergency quit', () => {
    app.quit();
  });
}

function scheduleDisplaySync(): void {
  if (quitting) {
    return;
  }

  if (displaySyncTimer !== null) {
    clearTimeout(displaySyncTimer);
  }

  displaySyncTimer = setTimeout(() => {
    displaySyncTimer = null;
    syncOverlays();
  }, DISPLAY_SYNC_DEBOUNCE_MS);
}

function normalizeBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function syncOverlays(): void {
  if (quitting) {
    return;
  }

  const nextDisplays = screen.getAllDisplays();
  const nextDisplayIds = new Set(nextDisplays.map((display) => display.id));
  displays = nextDisplays;
  logCrash(`syncOverlays begin displays=${nextDisplays.length}`);

  for (const [displayId, overlay] of [...overlays]) {
    if (nextDisplayIds.has(displayId)) {
      continue;
    }

    overlays.delete(displayId);
    if (!overlay.window.isDestroyed()) {
      overlay.window.destroy();
    }
  }

  for (const display of nextDisplays) {
    const bounds = normalizeBounds(display.bounds);
    const existing = overlays.get(display.id);

    if (!existing || existing.window.isDestroyed()) {
      if (existing) {
        overlays.delete(display.id);
      }

      try {
        overlays.set(display.id, createOverlay(display, bounds));
      } catch (error) {
        console.error(`[overlay] create failed display=${display.id}`, error);
        logCrash(
          `Overlay create failed display=${display.id}: ${describeError(error)}`,
        );
      }
      continue;
    }

    const currentBounds = existing.window.getBounds();
    if (
      currentBounds.x !== bounds.x ||
      currentBounds.y !== bounds.y ||
      currentBounds.width !== bounds.width ||
      currentBounds.height !== bounds.height
    ) {
      existing.window.setBounds(bounds);
    }
  }

  pumpCursor(true);
  logCrash(`syncOverlays complete overlays=${overlays.size}`);
}

let sandboxFallbackRelaunching = false;

function relaunchWithoutSandboxOnce(
  reason: string,
  exitCode: number,
): boolean {
  if (
    sandboxFallbackRelaunching ||
    !app.isPackaged ||
    process.platform !== 'win32' ||
    reason !== 'launch-failed' ||
    app.commandLine.hasSwitch('no-sandbox')
  ) {
    return false;
  }

  // Some Windows endpoint-security products and restricted sessions reject
  // Chromium's sandbox helper process with exit code 18. The renderer never
  // starts, so retrying inside the same process cannot help. Relaunch exactly
  // once with --no-sandbox; the new process sees the switch and will not loop.
  sandboxFallbackRelaunching = true;
  const args = [...process.argv.slice(1), '--no-sandbox'];
  logCrash(
    `Renderer launch-failed exitCode=${exitCode}; ` +
      `relaunching once with --no-sandbox args=${JSON.stringify(args)}`,
  );
  app.relaunch({ args });
  app.exit(0);
  return true;
}

function createOverlay(
  display: Display,
  bounds: Rectangle,
): OverlayWindow {
  console.log(
    `[overlay] create display=${display.id} bounds=${JSON.stringify(bounds)} ` +
      `scale=${display.scaleFactor}`,
  );

  logCrash(
    `createOverlay begin display=${display.id} bounds=${JSON.stringify(bounds)}`,
  );

  const overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: false,
    title: OVERLAY_WINDOW_TITLE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  logCrash(`createOverlay BrowserWindow constructed display=${display.id}`);

  const overlay: OverlayWindow = {
    displayId: display.id,
    window: overlayWindow,
    loaded: false,
  };

  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.setFocusable(false);
  overlayWindow.setSkipTaskbar(true);
  overlayWindow.setResizable(false);
  overlayWindow.setMovable(false);
  overlayWindow.setMinimizable(false);
  overlayWindow.setMaximizable(false);
  overlayWindow.setFullScreenable(false);
  overlayWindow.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL);
  applyClickThrough(overlayWindow);

  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  overlayWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[overlay] preload error', preloadPath, error);
    logCrash(
      `Overlay preload error path=${preloadPath}: ${describeError(error)}`,
    );
  });

  overlayWindow.webContents.on(
    'console-message',
    (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    },
  );

  const devServerUrl = DEV_RENDERER_URL;

  overlayWindow.webContents.on('will-navigate', (event, url) => {
    if (!devServerUrl || !url.startsWith(devServerUrl)) {
      event.preventDefault();
    }
  });

  overlayWindow.once('ready-to-show', () => {
    logCrash(`Overlay ready-to-show display=${display.id}`);
    revealOverlay(overlay, 'ready-to-show');
  });

  overlayWindow.webContents.on('did-finish-load', () => {
    logCrash(`Overlay did-finish-load display=${display.id}`);
    overlay.loaded = true;
    applyClickThrough(overlayWindow);
    // Renderer starts at the compile-time defaults; replace them with the
    // persisted, user-tuned values before the first frame is shown.
    overlayWindow.webContents.send(
      IPC_CHANNELS.displaySettings,
      currentDisplaySettings(),
    );
    overlayWindow.webContents.send(
      IPC_CHANNELS.skinChanged,
      currentSkinState(),
    );
    revealOverlay(overlay, 'did-finish-load');
    pumpCursor(true);
  });

  overlayWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[overlay] load failed (${errorCode}): ${errorDescription} ${validatedURL}`,
      );
      logCrash(
        `Overlay load failed display=${display.id} code=${errorCode} ` +
          `description=${errorDescription} url=${validatedURL}`,
      );
    },
  );

  overlayWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[overlay] renderer gone: ${details.reason}`);
    logCrash(
      `Overlay render-process-gone display=${display.id} ` +
        `reason=${details.reason} exitCode=${details.exitCode}`,
    );
    if (relaunchWithoutSandboxOnce(details.reason, details.exitCode)) {
      return;
    }
    forceIdle('renderer-gone');
  });

  overlayWindow.webContents.on('unresponsive', () => {
    logCrash(`Overlay renderer unresponsive display=${display.id}`);
  });

  overlayWindow.on('closed', () => {
    logCrash(`Overlay window closed display=${display.id}`);
    overlays.delete(display.id);
  });

  if (devServerUrl) {
    void overlayWindow
      .loadURL(`${devServerUrl}/index.html`)
      .catch((error: unknown) => {
        console.error('[overlay] loadURL failed', error);
      });
  } else {
    const rendererHtml = path.join(RENDERER_DIR, 'index.html');

    logCrash(`Overlay loadFile start display=${display.id} path=${rendererHtml}`);
    void overlayWindow
      .loadFile(rendererHtml)
      .then(() => {
        logCrash(`Overlay loadFile resolved display=${display.id}`);
      })
      .catch((error: unknown) => {
        console.error('[overlay] loadFile failed', error);
        logCrash(
          `Overlay loadFile rejected display=${display.id}: ${describeError(error)}`,
        );
      });
  }

  return overlay;
}

function applyClickThrough(window: ElectronBrowserWindow): void {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    window.setIgnoreMouseEvents(true, { forward: true });
    return;
  }

  window.setIgnoreMouseEvents(true);
}

/**
 * Re-assert the topmost band and put the overlay at the front of that band.
 *
 * `setAlwaysOnTop(true)` alone only sets WS_EX_TOPMOST. It does not change the
 * order of windows already in the topmost band, so the Windows 11 taskbar or a
 * freshly opened Start menu can still cover us. moveTop() is the missing half:
 * it performs SetWindowPos(HWND_TOP) without moving, resizing or activating the
 * overlay. Click-through is re-applied immediately afterwards.
 */
function raiseOverlayZOrder(reason: string, force = false): number {
  if (!overlayVisible || quitting) {
    return 0;
  }

  const now = Date.now();
  if (!force && now - lastOverlayZOrderRaisedAt < OVERLAY_Z_ORDER_THROTTLE_MS) {
    return 0;
  }
  lastOverlayZOrderRaisedAt = now;

  let raised = 0;
  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }
    if (!overlay.window.isVisible()) {
      continue;
    }

    try {
      overlay.window.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL);
      overlay.window.moveTop();
      applyClickThrough(overlay.window);
      raised += 1;
    } catch (error) {
      console.error(
        `[overlay] z-order raise failed display=${overlay.displayId}`,
        error,
      );
      logCrash(
        `Overlay z-order raise failed display=${overlay.displayId} ` +
          `reason=${reason}: ${describeError(error)}`,
      );
    }
  }

  if (raised > 0) {
    console.log(`[overlay] z-order raised reason=${reason} count=${raised}`);
  }
  return raised;
}

/**
 * Immediate raise plus one delayed retry. Start menu/search opens its shell
 * window a few frames after the Win key or taskbar click, so a single raise at
 * event time can be overwritten. The retry is coalesced to one timer.
 */
function nudgeOverlayZOrder(reason: string): void {
  raiseOverlayZOrder(reason);

  if (overlayZOrderRetryTimer !== null) {
    clearTimeout(overlayZOrderRetryTimer);
  }
  overlayZOrderRetryTimer = setTimeout(() => {
    overlayZOrderRetryTimer = null;
    raiseOverlayZOrder(`${reason}:retry`, true);
  }, OVERLAY_Z_ORDER_RETRY_MS);
  overlayZOrderRetryTimer.unref();
}

function startOverlayZOrderWatchdog(): void {
  if (overlayZOrderWatchdog !== null || quitting) {
    return;
  }

  // A cheap safety net for shell UI that appears without a mouse/key event
  // reaching uiohook (for example, the Start menu when the pointer is still).
  // This is two SetWindowPos calls per second, not a render loop.
  overlayZOrderWatchdog = setInterval(() => {
    raiseOverlayZOrder('watchdog', true);
  }, OVERLAY_Z_ORDER_WATCHDOG_MS);
  overlayZOrderWatchdog.unref();
  logCrash('Overlay z-order watchdog armed (500ms)');
}

function stopOverlayZOrderWatchdog(): void {
  if (overlayZOrderWatchdog !== null) {
    clearInterval(overlayZOrderWatchdog);
    overlayZOrderWatchdog = null;
  }
  if (overlayZOrderRetryTimer !== null) {
    clearTimeout(overlayZOrderRetryTimer);
    overlayZOrderRetryTimer = null;
  }
}

function revealOverlay(overlay: OverlayWindow, reason: string): void {
  if (!overlayVisible || quitting || overlay.window.isDestroyed()) {
    logCrash(
      `Overlay reveal skipped display=${overlay.displayId} reason=${reason} ` +
        `visibleFlag=${overlayVisible} quitting=${quitting} ` +
        `destroyed=${overlay.window.isDestroyed()}`,
    );
    return;
  }

  applyClickThrough(overlay.window);

  try {
    logCrash(`Overlay show start display=${overlay.displayId} reason=${reason}`);
    overlay.window.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL);
    if (!overlay.window.isVisible()) {
      overlay.window.showInactive();
      logCrash(
        `Overlay showInactive returned display=${overlay.displayId} ` +
          `visible=${overlay.window.isVisible()}`,
      );
    }
    overlay.window.setFocusable(false);
    overlay.window.setSkipTaskbar(true);
    raiseOverlayZOrder(`reveal:${reason}`, true);
  } catch (error) {
    console.error(`[overlay] reveal failed display=${overlay.displayId}`, error);
    logCrash(
      `Overlay reveal failed display=${overlay.displayId}: ${describeError(error)}`,
    );
  }

  console.log(
    `[overlay] reveal display=${overlay.displayId} reason=${reason} ` +
      `visible=${overlay.window.isVisible()}`,
  );
}

function showAllOverlays(): void {
  for (const overlay of overlays.values()) {
    if (!overlay.window.isDestroyed() && overlay.loaded) {
      revealOverlay(overlay, 'show-all');
    }
  }
}

function startCursorLoop(): void {
  if (cursorPoller !== null || quitting) {
    return;
  }

  lastCursorPoint = null;
  cursorPoller = setInterval(() => {
    pumpCursor();
  }, CURSOR_POLL_INTERVAL_MS);

  pumpCursor(true);
}

function stopCursorLoop(): void {
  if (cursorPoller === null) {
    return;
  }

  clearInterval(cursorPoller);
  cursorPoller = null;
}

function hideOverlay(overlay: OverlayWindow): void {
  if (overlay.window.isDestroyed()) {
    return;
  }

  if (overlay.loaded) {
    overlay.window.webContents.send(IPC_CHANNELS.cursorUpdate, {
      displayId: overlay.displayId,
      x: 0,
      y: 0,
      offsetX: 0,
      offsetY: 0,
      smoothingLevel: 0,
      visible: false,
    } satisfies CursorUpdate);
  }

  if (overlay.window.isVisible()) {
    overlay.window.hide();
  }
}

function pumpCursor(force = false): void {
  if (!overlayVisible || quitting) {
    return;
  }

  let point: ScreenPoint;

  try {
    point = screen.getCursorScreenPoint();
  } catch (error) {
    console.error('[cursor] getCursorScreenPoint failed', error);
    return;
  }

  if (
    !force &&
    lastCursorPoint !== null &&
    point.x === lastCursorPoint.x &&
    point.y === lastCursorPoint.y
  ) {
    return;
  }

  lastCursorPoint = point;

  const activeDisplay = screen.getDisplayNearestPoint(point);
  const activeOverlay = overlays.get(activeDisplay.id);

  for (const overlay of overlays.values()) {
    if (overlay !== activeOverlay) {
      hideOverlay(overlay);
    }
  }

  if (
    !activeOverlay ||
    !activeOverlay.loaded ||
    activeOverlay.window.isDestroyed()
  ) {
    return;
  }

  // ── Per-action overrides: when an action is active, its merged
  // settings (built in buildActiveActionData) override the global config
  // for offset / smoothing.  The duration override is handled inside
  // requestInspection.
  const actionMapping = activeActionId
    ? actionMappings.find((a) => a.id === activeActionId)
    : undefined;
  const actionS = actionMapping?.settings;

  const update: CursorUpdate = {
    displayId: activeDisplay.id,
    x: point.x - activeDisplay.bounds.x,
    y: point.y - activeDisplay.bounds.y,
    offsetX: actionS?.offsetX ?? appConfig.offsetX,
    offsetY: actionS?.offsetY ?? appConfig.offsetY,
    smoothingLevel: actionS?.smoothingLevel ?? appConfig.smoothingLevel,
    visible: true,
  };

  try {
    activeOverlay.window.webContents.send(IPC_CHANNELS.cursorUpdate, update);
  } catch (error) {
    console.error('[cursor] send failed', error);
    return;
  }

  // Cursor movement over the taskbar is the earliest signal that the shell is
  // about to show UI. The throttle inside raiseOverlayZOrder keeps this at
  // roughly 5 SetWindowPos calls/second even while the mouse moves at 60fps.
  nudgeOverlayZOrder('cursor-move');

  if (!activeOverlay.window.isVisible()) {
    revealOverlay(activeOverlay, 'cursor-enter-display');
  }
}

function setOverlayEnabled(nextEnabled: boolean): void {
  if (overlayVisible === nextEnabled) {
    refreshTrayMenu();
    return;
  }

  overlayVisible = nextEnabled;
  appConfig = { ...appConfig, overlayEnabled: nextEnabled };

  if (!overlayVisible) {
    void stopSystemCursorHider('overlay-disabled');
    forceIdle('overlay-disabled');
    stopCursorLoop();
    lastCursorPoint = null;

    for (const overlay of overlays.values()) {
      hideOverlay(overlay);
    }
  } else {
    showAllOverlays();
    startCursorLoop();
    pumpCursor(true);
    void startSystemCursorHider('overlay-enabled');
  }

  persistAppConfig(`overlayEnabled=${nextEnabled}`);
  refreshTrayMenu();
}

function openSettingsWindow(): void {
  if (quitting) {
    return;
  }

  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    void stopSystemCursorHider('settings-focus');
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    settingsWindow.show();
    settingsWindow.focus();
    raiseOverlayZOrder('settings-reopen', true);
    return;
  }

  // A globally hidden cursor would make the sliders unusable. Start the restore
  // without waiting; the settings window must appear immediately.
  void stopSystemCursorHider('settings-open');

  const window = new BrowserWindow({
    width: 540,
    height: 1040,
    minWidth: 500,
    minHeight: 760,
    show: false,
    frame: true,
    transparent: false,
    // The overlay must stay above the settings window. Never make Settings
    // topmost; its focus handler raises the click-through overlay instead.
    alwaysOnTop: false,
    backgroundColor: '#171b22',
    title: `${APP_NAME} 设置`,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [SETTINGS_WINDOW_ARG],
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  settingsWindow = window;
  window.setMenuBarVisibility(false);
  window.setAlwaysOnTop(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Settings takes keyboard focus, but the overlay is click-through and must
  // remain visually above it. Re-raising here does not steal focus.
  window.on('focus', () => {
    raiseOverlayZOrder('settings-focus', true);
  });

  const devServerUrl = DEV_RENDERER_URL;
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = devServerUrl
      ? url.startsWith(devServerUrl)
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
    }
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[settings] preload error', preloadPath, error);
  });

  window.webContents.on(
    'console-message',
    (_event, level, message, line, sourceId) => {
      console.log(`[settings:${level}] ${message} (${sourceId}:${line})`);
    },
  );

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
      raiseOverlayZOrder('settings-ready', true);
    }
  });

  window.webContents.on('did-finish-load', () => {
    console.log('[settings] window loaded');
    // The DSH/remote desktop session does not always deliver a focus event to
    // the settings window. Raising after load is deterministic and does not
    // depend on the window manager granting focus.
    raiseOverlayZOrder('settings-loaded', true);
  });

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[settings] load failed (${errorCode}): ${errorDescription} ${validatedURL}`,
      );
    },
  );

  window.on('closed', () => {
    if (settingsWindow === window) {
      settingsWindow = null;
    }
    console.log('[settings] window closed');
    if (appConfig.hideSystemCursor) {
      void startSystemCursorHider('settings-closed');
    }
  });

  if (devServerUrl) {
    const settingsUrl = new URL(
      'settings.html',
      devServerUrl.endsWith('/') ? devServerUrl : `${devServerUrl}/`,
    ).toString();

    void window.loadURL(settingsUrl).catch((error: unknown) => {
      console.error('[settings] loadURL failed', error);
    });
  } else {
    const settingsHtml = path.join(RENDERER_DIR, 'settings.html');

    void window.loadFile(settingsHtml).catch((error: unknown) => {
      console.error('[settings] loadFile failed', error);
    });
  }

  console.log('[settings] window created');
}

function trayIconCandidates(): string[] {
  return [
    path.join(app.getAppPath(), 'assets', 'tray.png'),
    path.join(process.resourcesPath, 'app.asar', 'assets', 'tray.png'),
    path.join(process.cwd(), 'assets', 'tray.png'),
  ];
}

/**
 * Tray icon: one ordinary PNG file on disk. No base64, no generated bitmap.
 * createFromPath reads from app.asar transparently on Windows.
 */
function resolveTrayIcon(): NativeImage {
  for (const candidate of trayIconCandidates()) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const icon = nativeImage.createFromPath(candidate);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  throw new Error(
    'assets/tray.png was not found or could not be decoded. ' +
      'Check that electron-builder includes /assets/tray.png.',
  );
}

function createTray(): void {
  if (DISABLE_TRAY_FOR_DIAGNOSTICS) {
    tray = null;
    logCrash('Tray skipped by KNIFE_CURSOR_DISABLE_TRAY=1');
    return;
  }

  try {
    logCrash('Tray: resolving icon');
    tray = new Tray(resolveTrayIcon());
    tray.setToolTip(`${APP_NAME} — F 检视`);
    // Do not let Electron open the menu automatically: showTrayMenu restores
    // the native pointer first, otherwise the menu is impossible to aim at.
    tray.on('click', showTrayMenu);
    tray.on('right-click', showTrayMenu);
    refreshTrayMenu();
    console.log('[tray] created');
    logCrash('Tray: created');
  } catch (error) {
    tray = null;
    console.error('[tray] creation failed', error);
    logCrash(`Tray creation failed: ${describeError(error)}`);
    dialog.showErrorBox(
      '托盘创建失败',
      `托盘图标未能创建。\n\n${describeError(error)}\n\n` +
        `仍可使用 ${FALLBACK_TRIGGER_SHORTCUT} 触发检视，` +
        `${EMERGENCY_QUIT_SHORTCUT} 退出。`,
    );
  }
}

function refreshTrayMenu(): void {
  if (tray === null) {
    return;
  }

  const hookLabel = uiohookStarted
    ? '全局键盘钩子：F 已启用'
    : uiohookError !== null
      ? '全局键盘钩子：启动失败'
      : '全局键盘钩子：未启动';

  const menu = Menu.buildFromTemplate([
    {
      label: '启用覆盖层（取消勾选即暂停）',
      type: 'checkbox',
      checked: overlayVisible,
      click: (menuItem) => {
        setOverlayEnabled(menuItem.checked);
      },
    },
    { type: 'separator' },
    {
      label: '检视触发方式',
      submenu: [
        {
          label: '忽略（播放中不响应）',
          type: 'radio',
          checked: appConfig.retriggerMode === 'ignore',
          click: () => {
            setRetriggerMode('ignore');
          },
        },
        {
          label: '立即重播（从第 0 帧重新开始）',
          type: 'radio',
          checked: appConfig.retriggerMode === 'restart',
          click: () => {
            setRetriggerMode('restart');
          },
        },
      ],
    },
    { label: hookLabel, enabled: false },
    { label: `备用触发：${FALLBACK_TRIGGER_SHORTCUT}`, enabled: false },
    { type: 'separator' },
    {
      label: '⚙️ 设置...',
      click: () => {
        openSettingsWindow();
      },
    },
    {
      label:
        `动画 ${appConfig.inspectionDurationMs}ms · ` +
        `光标 ${appConfig.knifeDisplaySize}px · ` +
        `偏移 ${appConfig.offsetX},${appConfig.offsetY} · ` +
        `松紧 ${appConfig.smoothingLevel} · ` +
        `系统光标${appConfig.hideSystemCursor ? '隐藏' : '显示'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '退出 Knife Cursor',
      click: () => {
        app.quit();
      },
    },
  ]);

  trayMenu = menu;

  menu.on('menu-will-close', () => {
    // menu-will-close fires for popup menus as well as application menus.
    if (appConfig.hideSystemCursor) {
      void startSystemCursorHider('tray-menu-closed');
    }
  });
}

async function teardown(): Promise<void> {
  if (quitting) {
    return;
  }

  quitting = true;
  logCrash('Teardown begin');

  // before-quit waits for this promise. The UI can disappear immediately
  // afterwards; keeping the process alive until the arrow is restored is what
  // makes an ordinary quit deterministic without blocking the main thread.
  await stopSystemCursorHider('teardown');
  logCrash('Teardown: cursor restore finished');

  stopKeepAliveTimer();
  stopOverlayZOrderWatchdog();
  flushPendingConfigSave();
  stopCursorLoop();
  stopKeyboardHook();

  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    settingsWindow.destroy();
  }
  settingsWindow = null;

  if (displaySyncTimer !== null) {
    clearTimeout(displaySyncTimer);
    displaySyncTimer = null;
  }

  clearInspectionSafetyTimer();

  const remainingOverlays = [...overlays.values()];
  overlays.clear();

  for (const overlay of remainingOverlays) {
    if (!overlay.window.isDestroyed()) {
      overlay.window.destroy();
    }
  }

  if (tray !== null) {
    tray.destroy();
    tray = null;
  }

  try {
    globalShortcut.unregisterAll();
  } catch (error) {
    console.warn('[shortcut] unregisterAll failed', error);
  }

  console.log('[main] teardown complete');
  logCrash('Teardown complete');
}