import './index.css';
import {
  DEFAULT_INSPECTION_DURATION_MS,
  DEFAULT_KNIFE_DISPLAY_SIZE,
  DEFAULT_OFFSET,
  DEFAULT_SMOOTHING_LEVEL,
  MAX_OFFSET,
  MAX_SMOOTHING_LEVEL,
  MIN_OFFSET,
  MIN_SMOOTHING_LEVEL,
} from './shared/ipc';
import type {
  ActiveActionData,
  CursorUpdate,
  DisplaySettings,
  IdleAnimationData,
  InspectionReset,
  InspectionStart,
  SkinState,
} from './shared/ipc';
import {
  createActionAssets,
  loadKnifeAssets,
  preloadKnifeAssets,
} from './renderer/knife-assets';

const SNAP_EPSILON_PX = 0.05;
const MAX_FRAME_DELTA_MS = 64;
const DEFAULT_FRAME_DELTA_MS = 16;

let knifeDisplaySize = DEFAULT_KNIFE_DISPLAY_SIZE;
let halfKnifeSize = knifeDisplaySize / 2;
let knifeOffsetX = DEFAULT_OFFSET;
let knifeOffsetY = DEFAULT_OFFSET;
let smoothingLevel = DEFAULT_SMOOTHING_LEVEL;
const proxy = document.getElementById('cursor-proxy');
const knife = document.getElementById('knife-image');

if (!(proxy instanceof HTMLDivElement)) {
  throw new Error('Missing #cursor-proxy element');
}

if (!(knife instanceof HTMLImageElement)) {
  throw new Error('Missing #knife-image element');
}

const proxyElement: HTMLDivElement = proxy;
const knifeImage: HTMLImageElement = knife;
let assets = loadKnifeAssets();

/**
 * Snapshot of the built-in (compiled-in) assets captured at boot so we can
 * switch back to them when `handleActionActivated` receives actionId:null.
 */
const defaultAssets = assets;

proxyElement.style.width = `${knifeDisplaySize}px`;
proxyElement.style.height = `${knifeDisplaySize}px`;
knifeImage.draggable = false;

/**
 * Fallback for broken action-frame images (e.g. 404 from knife-asset://
 * because the directory was moved or a ghost entry was loaded).  Switch
 * the image back to the built-in idle so the user sees *something*
 * instead of a broken-image placeholder.
 */
knifeImage.addEventListener('error', () => {
  if (currentImageUrl === defaultAssets.idleUrl) {
    return; // already on fallback — prevent infinite loop
  }

  console.warn(
    `[renderer] image load failed; falling back to built-in idle. ` +
      `failed-url=${currentImageUrl.slice(0, 120)}`,
  );

  currentImageUrl = defaultAssets.idleUrl;
  knifeImage.src = defaultAssets.idleUrl;
});

type InspectionState = 'idle' | 'inspecting';

let targetX = 0;
let targetY = 0;
let currentX = 0;
let currentY = 0;
let hasPosition = false;
let visible = false;
let frameRequest: number | null = null;
let lastFrameTimestamp = 0;

let inspectionState: InspectionState = 'idle';
let activeInstanceId = 0;

let playbackFrame: number | null = null;
let playbackEndTimer: number | null = null;
let playbackFrameUrls: readonly string[] = [];
let playbackStartedAt = 0;
let playbackDurationMs = 0;
let playbackIndex = -1;
let currentImageUrl = '';

/** Snapshot of the most recent global display settings sent via IPC.
 *  Saved so the renderer can restore global defaults after a per-action
 *  override (settings page changes always write to global). */
let globalDisplaySettings: DisplaySettings | null = null;

// ─── Idle Animation State ───────────────────────────────────────────
let idleAnim = {
  active: false,
  frameUrls: [] as readonly string[],
  idleFallbackUrl: '',
  currentFrame: 0,
  rAFId: null as number | null,
  lastFrameTime: 0,
  fps: 12,
};

function setKnifeImage(url: string): void {
  if (currentImageUrl === url) {
    return;
  }

  currentImageUrl = url;
  knifeImage.src = url;
}

function applyPosition(x: number, y: number): void {
  proxyElement.style.transform =
    `translate3d(${x - halfKnifeSize + knifeOffsetX}px, ` +
    `${y - halfKnifeSize + knifeOffsetY}px, 0)`;
}

function clampOffset(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_OFFSET;
  }

  return Math.min(MAX_OFFSET, Math.max(MIN_OFFSET, Math.round(numeric)));
}

function clampSmoothingLevel(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SMOOTHING_LEVEL;
  }

  return Math.min(
    MAX_SMOOTHING_LEVEL,
    Math.max(MIN_SMOOTHING_LEVEL, Math.round(numeric)),
  );
}

function applyDisplaySettings(settings: DisplaySettings): void {
  // Always snapshot global defaults so we can restore after per-action overrides.
  globalDisplaySettings = {
    inspectionDurationMs: settings.inspectionDurationMs,
    knifeDisplaySize: settings.knifeDisplaySize,
    offsetX: settings.offsetX,
    offsetY: settings.offsetY,
    smoothingLevel: settings.smoothingLevel,
    hideSystemCursor: settings.hideSystemCursor,
  };

  const requestedSize = Number(settings.knifeDisplaySize);
  const nextSize =
    Number.isFinite(requestedSize) && requestedSize > 0
      ? Math.round(requestedSize)
      : DEFAULT_KNIFE_DISPLAY_SIZE;

  knifeDisplaySize = nextSize;
  halfKnifeSize = nextSize / 2;
  knifeOffsetX = clampOffset(settings.offsetX);
  knifeOffsetY = clampOffset(settings.offsetY);
  smoothingLevel = clampSmoothingLevel(settings.smoothingLevel);
  proxyElement.style.width = `${nextSize}px`;
  proxyElement.style.height = `${nextSize}px`;

  if (hasPosition) {
    applyPosition(currentX, currentY);
  }

  console.log(
    `[renderer] display size=${nextSize}px offset=${knifeOffsetX},${knifeOffsetY} ` +
      `smoothing=${smoothingLevel}`,
  );
}

function cancelScheduledFrame(): void {
  if (frameRequest === null) {
    return;
  }

  cancelAnimationFrame(frameRequest);
  frameRequest = null;
}

function setProxyVisible(nextVisible: boolean): void {
  if (visible === nextVisible) {
    return;
  }

  visible = nextVisible;
  proxyElement.classList.toggle('is-visible', nextVisible);

  if (!nextVisible) {
    cancelScheduledFrame();
    hasPosition = false;
    lastFrameTimestamp = 0;
  }
}

function requestFrame(): void {
  if (!visible || frameRequest !== null) {
    return;
  }

  frameRequest = requestAnimationFrame(step);
}

function step(timestamp: number): void {
  frameRequest = null;

  if (!visible || !hasPosition) {
    return;
  }

  const elapsed =
    lastFrameTimestamp === 0
      ? DEFAULT_FRAME_DELTA_MS
      : Math.min(MAX_FRAME_DELTA_MS, Math.max(1, timestamp - lastFrameTimestamp));
  lastFrameTimestamp = timestamp;

  if (smoothingLevel <= 0) {
    currentX = targetX;
    currentY = targetY;
    applyPosition(currentX, currentY);
    lastFrameTimestamp = 0;
    return;
  }

  const deltaX = targetX - currentX;
  const deltaY = targetY - currentY;
  // The slider value doubles as the time constant in milliseconds. At 45 it
  // reproduces the previous fixed 45ms feel; 100 gives a clearly visible lag.
  const alpha = 1 - Math.exp(-elapsed / smoothingLevel);

  currentX += deltaX * alpha;
  currentY += deltaY * alpha;

  if (
    Math.abs(targetX - currentX) <= SNAP_EPSILON_PX &&
    Math.abs(targetY - currentY) <= SNAP_EPSILON_PX
  ) {
    currentX = targetX;
    currentY = targetY;
    applyPosition(currentX, currentY);
    lastFrameTimestamp = 0;
    return;
  }

  applyPosition(currentX, currentY);
  requestFrame();
}

function revealAt(x: number, y: number): void {
  targetX = x;
  targetY = y;
  currentX = x;
  currentY = y;
  hasPosition = true;
  lastFrameTimestamp = 0;
  applyPosition(currentX, currentY);
  setProxyVisible(true);
}

function handleCursorUpdate(update: CursorUpdate): void {
  if (!update.visible) {
    setProxyVisible(false);
    return;
  }

  const x = Number.isFinite(update.x) ? update.x : 0;
  const y = Number.isFinite(update.y) ? update.y : 0;

  if (!hasPosition || !visible) {
    revealAt(x, y);
    return;
  }

  targetX = x;
  targetY = y;

  if (smoothingLevel <= 0) {
    // Hard bind: apply the fresh IPC sample in the same task instead of waiting
    // for another animation frame.
    currentX = targetX;
    currentY = targetY;
    lastFrameTimestamp = 0;
    applyPosition(currentX, currentY);
    return;
  }

  requestFrame();
}

function cancelInspectionPlayback(): void {
  if (playbackFrame !== null) {
    cancelAnimationFrame(playbackFrame);
    playbackFrame = null;
  }

  if (playbackEndTimer !== null) {
    window.clearTimeout(playbackEndTimer);
    playbackEndTimer = null;
  }

  playbackFrameUrls = [];
  playbackIndex = -1;
}

function showInspectionFrame(frameIndex: number): void {
  if (playbackFrameUrls.length === 0) {
    return;
  }

  const clamped = Math.min(
    playbackFrameUrls.length - 1,
    Math.max(0, frameIndex),
  );

  if (clamped === playbackIndex) {
    return;
  }

  playbackIndex = clamped;
  setKnifeImage(playbackFrameUrls[clamped]);
}

/**
 * Every playback gets an instanceId from main. The rAF loop and the safety
 * timer both check it, and finishInspection checks it again, so an old
 * playback can never end a newer restart. This replaces the old
 * animationend-based guard but keeps the same contract.
 */
function finishInspection(instanceId: number): void {
  if (inspectionState !== 'inspecting' || instanceId !== activeInstanceId) {
    return;
  }

  cancelInspectionPlayback();
  inspectionState = 'idle';
  setKnifeImage(assets.idleUrl);
  proxyElement.classList.remove('is-inspecting');

  window.knifeCursor?.notifyInspectionFinished({
    instanceId,
    reason: 'animationend',
  });

  console.log(
    `[renderer] inspection finished instance=${instanceId} ` +
      `frames=${assets.inspectFrameUrls.length}`,
  );
}

function startInspection(start: InspectionStart): void {
  if (!Number.isInteger(start.instanceId) || start.instanceId <= 0) {
    return;
  }

  if (start.instanceId <= activeInstanceId) {
    console.warn(
      `[renderer] ignored stale inspection start=${start.instanceId} ` +
        `current=${activeInstanceId}`,
    );
    return;
  }

  const wasInspecting = inspectionState === 'inspecting';
  cancelInspectionPlayback();

  // ── Interrupt idle animation while the action plays ──
  stopIdleAnimation();

  activeInstanceId = start.instanceId;
  inspectionState = 'inspecting';

  const durationMs =
    Number.isFinite(start.durationMs) && start.durationMs > 0
      ? start.durationMs
      : DEFAULT_INSPECTION_DURATION_MS;

  playbackFrameUrls = assets.inspectFrameUrls;
  playbackDurationMs = durationMs;
  playbackIndex = -1;
  setKnifeImage(playbackFrameUrls[0] ?? assets.idleUrl);

  proxyElement.classList.remove('is-inspecting');
  // Force the browser to paint the idle/removed state before re-adding the
  // class; this keeps fast restarts visually distinct without a CSS keyframe.
  void proxyElement.offsetWidth;
  proxyElement.classList.add('is-inspecting');

  playbackStartedAt = performance.now();
  const instanceId = start.instanceId;

  const tick = (timestamp: number): void => {
    playbackFrame = null;

    if (instanceId !== activeInstanceId || inspectionState !== 'inspecting') {
      return;
    }

    const elapsed = Math.max(0, timestamp - playbackStartedAt);

    if (elapsed >= playbackDurationMs) {
      showInspectionFrame(playbackFrameUrls.length - 1);
      finishInspection(instanceId);
      return;
    }

    const frameIndex = Math.min(
      playbackFrameUrls.length - 1,
      Math.floor((elapsed / playbackDurationMs) * playbackFrameUrls.length),
    );
    showInspectionFrame(frameIndex);
    playbackFrame = requestAnimationFrame(tick);
  };

  playbackFrame = requestAnimationFrame(tick);

  // requestAnimationFrame is throttled when a window is occluded. This timer
  // guarantees that main still receives the completion and leaves inspecting.
  playbackEndTimer = window.setTimeout(() => {
    playbackEndTimer = null;

    if (instanceId !== activeInstanceId || inspectionState !== 'inspecting') {
      return;
    }

    showInspectionFrame(playbackFrameUrls.length - 1);
    finishInspection(instanceId);
  }, playbackDurationMs + 80);

  console.log(
    `[renderer] inspection start instance=${instanceId} ` +
      `duration=${durationMs}ms frames=${playbackFrameUrls.length} ` +
      `mode=${wasInspecting ? 'restart' : 'first'} source=${assets.source}`,
  );
}

function handleInspectionReset(reset: InspectionReset): void {
  cancelInspectionPlayback();
  activeInstanceId = Math.max(activeInstanceId, reset.instanceId);
  inspectionState = 'idle';
  setKnifeImage(assets.idleUrl);
  proxyElement.classList.remove('is-inspecting');

  console.log(
    `[renderer] inspection reset instance=${activeInstanceId} reason=${reset.reason}`,
  );
}

/**
 * V2.0 action activation handler.
 *
 * The main process sends ActiveActionData (containing idleUrl + frameUrls)
 * immediately BEFORE the InspectionStart so the frame player sees the correct
 * assets when it begins. We switch assets and cancel any running inspection
 * here. The incoming InspectionStart will then pick up the new frameUrls.
 */
function handleActionActivated(data: ActiveActionData): void {
  // Interrupt any running inspection — the new action replaces it.
  cancelInspectionPlayback();
  proxyElement.classList.remove('is-inspecting');

  // actionId === null means "switch back to the built-in (compiled-in)
  // default assets", sent by sendResetToBuiltin before
  // Ctrl+Shift+Alt+F. Reload the original glob-loaded assets AND restore
  // global display settings (size / duration / offset / smoothing).
  if (data.actionId === null) {
    assets = defaultAssets;
    setKnifeImage(assets.idleUrl);
    inspectionState = 'idle';
    void preloadKnifeAssets(assets);

    // Restore global defaults that were saved from the last
    // api.onDisplaySettings call. This undoes any per-action overrides.
    if (globalDisplaySettings !== null) {
      applyDisplaySettings(globalDisplaySettings);
    }

    console.log(
      '[renderer] action reset-to-builtin frames=' + assets.realFrameCount,
    );
    return;
  }

  // ── Per-action effective settings (merged from global + per-action overrides) ──
  if (data.effectiveSettings !== null) {
    applyDisplaySettings(data.effectiveSettings);
    console.log(
      `[renderer] action applying per-action settings ` +
        `size=${data.effectiveSettings.knifeDisplaySize} ` +
        `duration=${data.effectiveSettings.inspectionDurationMs} ` +
        `offset=${data.effectiveSettings.offsetX},${data.effectiveSettings.offsetY} ` +
        `smoothing=${data.effectiveSettings.smoothingLevel}`,
    );
  }

  // ── Guard: reject empty action data (skin scan failed in main process) ──
  if (data.frameCount === 0 || data.frameUrls.length === 0) {
    console.warn(
      `[renderer] action data has NO frames id=${data.actionId} ` +
        `name="${data.actionName}" frameCount=${data.frameCount} ` +
        `idleUrl="${data.idleUrl.slice(0, 100)}" — falling back to built-in`,
    );

    // Keep built-in assets; do NOT switch to empty action assets.
    // The incoming InspectionStart will play the built-in animation.
    inspectionState = 'idle';
    return;
  }

  if (data.idleUrl.length === 0) {
    console.warn(
      `[renderer] action data has NO idle URL id=${data.actionId} ` +
        `name="${data.actionName}" — using first frame as idle`,
    );
    // createActionAssets will use frameUrls[0] as idle fallback.
  }

  // Switch to the action's art. createActionAssets() wraps the main-provided
  // knife-asset://action/<id>/... URLs into a KnifeAssets snapshot.
  assets = createActionAssets(data);
  setKnifeImage(assets.idleUrl);

  // Return to idle so the incoming InspectionStart is a clean "first" start.
  inspectionState = 'idle';
  // Do NOT reset activeInstanceId — let startInspection advance it.

  console.log(
    `[renderer] action activated id=${data.actionId} name="${data.actionName}" ` +
      `frames=${data.frameCount} ${data.idleUrl ? 'idleUrl=' + data.idleUrl.slice(0, 60) + '...' : 'no idle'}`,
  );

  // Preload the action frames so the player has them decoded before the first
  // tick. Fails silently on decode errors (frame player falls back to on-demand).
  void preloadKnifeAssets(assets);
}

// ═══════════════════════════════════════════════════════════════════
//  Idle-loop animation
// ═══════════════════════════════════════════════════════════════════

function stopIdleAnimation(): void {
  if (!idleAnim.active) {
    return;
  }

  idleAnim.active = false;

  if (idleAnim.rAFId !== null) {
    cancelAnimationFrame(idleAnim.rAFId);
    idleAnim.rAFId = null;
  }

  // Reset to the static idle image of the current assets.
  // If we're in the middle of a per-action inspection the caller is
  // responsible for calling setKnifeImage again, so this is a safe
  // floor.
  setKnifeImage(assets.idleUrl);
}

function tickIdleAnimation(timestamp: number): void {
  if (!idleAnim.active || idleAnim.frameUrls.length === 0) {
    stopIdleAnimation();
    return;
  }

  const elapsed = timestamp - idleAnim.lastFrameTime;
  const frameIntervalMs = 1000 / idleAnim.fps;

  if (elapsed >= frameIntervalMs) {
    idleAnim.currentFrame =
      (idleAnim.currentFrame + 1) % idleAnim.frameUrls.length;
    idleAnim.lastFrameTime = timestamp;
    setKnifeImage(idleAnim.frameUrls[idleAnim.currentFrame]);
  }

  if (idleAnim.active) {
    idleAnim.rAFId = requestAnimationFrame(tickIdleAnimation);
  }
}

function startIdleAnimation(data: IdleAnimationData): void {
  if (idleAnim.active) {
    stopIdleAnimation();
  }

  // No idle action designated → static idle.
  if (
    data.actionId === null ||
    data.frameCount === 0 ||
    data.frameUrls.length === 0
  ) {
    return;
  }

  idleAnim.frameUrls = data.frameUrls;
  idleAnim.idleFallbackUrl = data.idleStaticUrl;
  idleAnim.fps = Number.isFinite(data.fps) && data.fps > 0 ? data.fps : 12;
  idleAnim.currentFrame = 0;
  idleAnim.lastFrameTime = 0;
  idleAnim.active = true;

  // Show the first frame immediately.
  if (idleAnim.frameUrls.length > 0) {
    setKnifeImage(idleAnim.frameUrls[0]);
  }

  idleAnim.rAFId = requestAnimationFrame((ts) => {
    idleAnim.lastFrameTime = ts;
    idleAnim.rAFId = requestAnimationFrame(tickIdleAnimation);
  });

  console.log(
    `[idle] animation started actionId="${data.actionId}" ` +
    `name="${data.actionName}" frames=${data.frameCount} fps=${idleAnim.fps}`,
  );
}

function handleIdleAnimationChanged(data: IdleAnimationData): void {
  console.log(
    `[idle] animation-changed actionId="${data.actionId}" ` +
    `frames=${data.frameCount} isInspecting=${inspectionState === 'inspecting'}`,
  );

  if (inspectionState === 'inspecting') {
    // Don't start a new idle animation while an action is playing.
    // The main process will re-send after the inspection finishes.
    return;
  }

  startIdleAnimation(data);
}

function handleVisibilityChange(): void {
  if (document.visibilityState !== 'hidden') {
    return;
  }

  if (inspectionState !== 'inspecting') {
    return;
  }

  const instanceId = activeInstanceId;
  cancelInspectionPlayback();
  inspectionState = 'idle';
  setKnifeImage(assets.idleUrl);
  proxyElement.classList.remove('is-inspecting');

  window.knifeCursor?.notifyInspectionFinished({
    instanceId,
    reason: 'hidden',
  });

  console.log(
    `[renderer] inspection aborted instance=${instanceId} reason=hidden`,
  );
}

function applySkinState(skin: SkinState): void {
  const nextAssets = loadKnifeAssets(skin);

  // A skin switch during an inspection should not keep playing frames from the
  // previous folder. Finish the current instance first, then show the new idle.
  if (inspectionState === 'inspecting') {
    assets = nextAssets;
    finishInspection(activeInstanceId);
  } else {
    assets = nextAssets;
    setKnifeImage(assets.idleUrl);
    proxyElement.classList.remove('is-inspecting');
  }

  console.log(
    `[assets] skin changed mode=${skin.mode} source=${assets.source} ` +
      `frames=${assets.inspectFrameUrls.length} path=${skin.customPath ?? '(builtin)'}`,
  );

  if (skin.error !== null) {
    console.warn(`[assets] ${skin.error}`);
  }

  void preloadKnifeAssets(assets);
}

function boot(): void {
  setKnifeImage(assets.idleUrl);

  console.log(
    `[assets] source=${assets.source} frames=${assets.inspectFrameUrls.length} ` +
      `realFrames=${assets.realFrameCount} size=${knifeDisplaySize}px`,
  );

  if (assets.usingFallbackFrames) {
    console.warn(
      '[assets] no frame_*.png found; using the built-in SVG animation. ' +
        'Drop real PNGs into src/renderer/assets/cursor/butterfly/inspect/.',
    );
  }

  void preloadKnifeAssets(assets);

  const api = window.knifeCursor;
  if (!api) {
    console.error('[renderer] preload bridge is unavailable');
    return;
  }

  api.onCursorUpdate(handleCursorUpdate);
  api.onInspectionStart(startInspection);
  api.onInspectionReset(handleInspectionReset);
  api.onDisplaySettings(applyDisplaySettings);
  api.onSkinChanged(applySkinState);
  api.onActionActivated(handleActionActivated);
  api.onIdleAnimationChanged(handleIdleAnimationChanged);

  document.addEventListener('visibilitychange', handleVisibilityChange);

  window.addEventListener(
    'beforeunload',
    () => {
      cancelInspectionPlayback();
      api.offCursorUpdate();
      api.offInspectionStart();
      api.offInspectionReset();
      api.offDisplaySettings();
      api.offSkinChanged();
      api.offActionActivated();
      api.offIdleAnimationChanged();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    },
    { once: true },
  );
}

boot();