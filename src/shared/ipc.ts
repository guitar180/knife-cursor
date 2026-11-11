/**
 * Inter-process communication contract shared between main, preload, the
 * overlay renderer AND the settings renderer.  All channel names, message
 * types and helper functions live here so the three processes can never
 * drift on a string or field name.
 */

/* ── Values also consumed by config.ts (duplicate in that file is ok) ── */
export const DEFAULT_INSPECTION_DURATION_MS = 500;
export const INSPECTION_DURATION_STEP_MS = 100;
export const MIN_INSPECTION_DURATION_MS = 300;
export const MAX_INSPECTION_DURATION_MS = 2000;

export const DEFAULT_KNIFE_DISPLAY_SIZE = 96;
export const KNIFE_DISPLAY_SIZE_STEP = 8;
export const MIN_KNIFE_DISPLAY_SIZE = 32;
export const MAX_KNIFE_DISPLAY_SIZE = 256;

export const DEFAULT_OFFSET = 0;
export const OFFSET_STEP = 1;
export const MIN_OFFSET = -128;
export const MAX_OFFSET = 128;

export const DEFAULT_SMOOTHING_LEVEL = 45;
export const SMOOTHING_LEVEL_STEP = 1;
export const MIN_SMOOTHING_LEVEL = 0;
export const MAX_SMOOTHING_LEVEL = 100;

export const DEFAULT_HIDE_SYSTEM_CURSOR = false;

/** FPS for the looping idle animation (low overhead, no audio sync needed). */
export const IDLE_ANIMATION_FPS = 12;

/* ── IPC channel names ── */
export const IPC_CHANNELS = {
  cursorUpdate: 'knife:cursor-update',
  inspectionStart: 'knife:inspection-start',
  inspectionFinished: 'knife:inspection-finished',
  inspectionReset: 'knife:inspection-reset',
  displaySettings: 'knife:display-settings',
  skinChanged: 'knife:skin-changed',
  actionActivated: 'knife:action-activated',
  idleAnimationChanged: 'knife:idle-animation-changed',

  // Settings window → main
  settingsGet: 'knife:settings-get',
  settingsUpdate: 'knife:settings-update',
  skinGet: 'knife:skin-get',
  skinChoose: 'knife:skin-choose',
  skinReset: 'knife:skin-reset',
  actionsList: 'knife:actions-list',
  actionsScan: 'knife:actions-scan',
  actionsSet: 'knife:actions-set',
  actionsRemove: 'knife:actions-remove',
  actionsChooseRoot: 'knife:actions-choose-root',
  actionsStartRecording: 'knife:actions-start-recording',
  actionsCancelRecording: 'knife:actions-cancel-recording',
  actionKeyRecorded: 'knife:action-key-recorded',
  actionsReset: 'knife:actions-reset',
  actionsSetIdle: 'knife:actions-set-idle',
} as const;

/** Argument passed to BrowserWindow so the preload script knows it is Settings. */
export const SETTINGS_WINDOW_ARG = '--knife-settings-window';

/* ── Messages main → renderer ── */

export interface CursorUpdate {
  x: number;
  y: number;
  /** CSS pixels the image is offset relative to the physical cursor hotspot. */
  offsetX: number;
  offsetY: number;
  /** 0–100; renderer applies CSS filter: blur(...) based on this. */
  smoothingLevel: number;
  /** Display id this update targets (for per-display windows). */
  displayId: number;
  /** Whether the overlay is currently visible. */
  visible: boolean;
}

export interface InspectionStart {
  instanceId: number;
  durationMs: number;
  /** 'ignore' | 'restart' */
  retriggerMode: string;
}

/**
 * Sent from main to renderer when display/size/offset/smoothing changes.
 * This is the union of every real-time rendering hint the overlay needs.
 */
export interface DisplaySettings {
  knifeDisplaySize: number;
  inspectionDurationMs: number;
  offsetX: number;
  offsetY: number;
  smoothingLevel: number;
  hideSystemCursor: boolean;
}

/**
 * ───────────────────────────────────────────────
 *             V2.0 多动作类型
 * ───────────────────────────────────────────────
 */

/** Per-action display overrides. Every field is optional; missing fields fall back to global. */
export interface ActionSettings {
  inspectionDurationMs?: number;
  knifeDisplaySize?: number;
  smoothingLevel?: number;
  offsetX?: number;
  offsetY?: number;
}

export interface ActionMapping {
  id: string;
  /** Human-readable label shown in the UI. */
  name: string;
  /** Absolute path to a folder containing idle.png + frame_*.png. */
  path: string;
  /** uiohook-napi virtual-key code.  0 means unassigned (UI-only placeholder). */
  keycode: number;
  /** Human-readable display string, e.g. "F", "Ctrl+G", "Shift+Space". */
  keyName: string;
  /** Bitmask: bit0=Ctrl, bit1=Alt, bit2=Shift (Windows modifier order). */
  modifiers: number;
  /** Per-action overrides for size / duration / offset / smoothing. */
  settings?: ActionSettings;
}

/**
 * Sent from main to settings when the user presses a physical key during
 * key-recording mode. The keycode field is a uiohook-napi virtual-key code.
 */
export interface ActionKeyRecorded {
  actionId: string;
  keycode: number;
  /** Set by main for convenience; always non-zero when sent. */
  keyName: string;
}

/**
 * Sent to the overlay renderer when the user presses a mapped key.
 * Contains everything the renderer needs to switch art immediately.
 */
export interface ActiveActionData {
  actionId: string | null;
  actionName: string;
  idleUrl: string;
  frameUrls: readonly string[];
  frameCount: number;
  /**
   * Per-action effective display settings merged from global defaults +
   * ActionMapping.settings.  `null` means "use global defaults" (sent
   * for Ctrl+Shift+Alt+F / reset-to-builtin).
   */
  effectiveSettings: DisplaySettings | null;
}

/**
 * Sent to the overlay renderer when the idle-animation action changes (or
 * is cleared).  Contains everything the renderer needs to start/stop a
 * low-fps looping animation in place of the static idle.png.
 */
export interface IdleAnimationData {
  /** null when no action is designated as idle animation → fallback to static. */
  actionId: string | null;
  actionName: string | null;
  /** knife-asset://action/<id>/frame_XXX.png URLs. Empty means no animation. */
  frameUrls: readonly string[];
  /** Static idle.png fallback (built-in or action's idle.png). */
  idleStaticUrl: string;
  /** Number of frames in the sequence.  0 = no animation. */
  frameCount: number;
  /** Target FPS for the idle loop. */
  fps: number;
}

/**
 * Result of scanning a root directory for sub-folders that look like actions.
 */
export interface ActionScanResult {
  ok: boolean;
  rootPath: string;
  /** Relative sub-folder names that contain at least one frame_*.png. */
  candidates: string[];
  error: string | null;
}

/**
 * ───────────────────────────────────────────────
 *                      SkinState (unchanged)
 * ───────────────────────────────────────────────
 */

/**
 * Custom artwork is served from the main process through the privileged
 * `knife-asset://skin/<filename>` protocol. The renderer must not know about
 * the real filesystem path of a custom skin.
 */
export interface SkinState {
  mode: 'builtin' | 'custom';
  /** Non-null when mode === 'custom'; the raw setting persisted to disk. */
  customPath: string | null;
  frameCount: number;
  idleUrl: string | null;
  frameUrls: readonly string[];
  /** Non-null when a configured skin folder is broken. */
  error: string | null;
}

export interface SkinSelectionResult {
  path: string | null;
  /** The resolved skin state (mode, frameCount, etc.). */
  skin: SkinState | null;
  error: string | null;
  canceled: boolean;
  changed: boolean;
}

/* ── Messages renderer → main ── */

export interface InspectionFinished {
  instanceId: number;
  reason: string;
}

export interface InspectionReset {
  instanceId: number;
  reason: string;
}

export type RetriggerMode = 'ignore' | 'restart';

/**
 * ───────────────────────────────────────────────
 *                     Window-bound APIs
 * ───────────────────────────────────────────────
 */

/**
 * Exposed on window.knifeCursor inside the overlay renderer.
 */
export interface KnifeCursorApi {
  onCursorUpdate(callback: (update: CursorUpdate) => void): void;
  offCursorUpdate(): void;
  onInspectionStart(callback: (start: InspectionStart) => void): void;
  offInspectionStart(): void;
  onInspectionReset(callback: (reset: InspectionReset) => void): void;
  offInspectionReset(): void;
  onDisplaySettings(callback: (settings: DisplaySettings) => void): void;
  offDisplaySettings(): void;
  onSkinChanged(callback: (skin: SkinState) => void): void;
  offSkinChanged(): void;

  /** V2.0: fired when the user presses a mapped action key. */
  onActionActivated(callback: (data: ActiveActionData) => void): void;
  offActionActivated(): void;

  /** Idle animation: fired when the idle-animation action changes. */
  onIdleAnimationChanged(callback: (data: IdleAnimationData) => void): void;
  offIdleAnimationChanged(): void;

  notifyInspectionFinished(finished: InspectionFinished): void;
}

/**
 * Exposed on window.knifeSettings inside the settings renderer.
 */
export interface SettingsApi {
  get(): Promise<AppConfigSnapshot>;
  update(patch: Partial<AppConfigSnapshot>): Promise<AppConfigSnapshot>;

  // ── Custom skin ──
  getSkin(): Promise<SkinState>;
  chooseSkin(): Promise<SkinSelectionResult>;
  resetSkin(): Promise<SkinSelectionResult>;

  // ── V2.0 多动作 ──
  listActions(): Promise<ActionMapping[]>;
  scanRootDirectory(rootPath: string): Promise<ActionScanResult>;
  /** Opens a native folder picker; returns the selected path or null. */
  chooseActionRootDirectory(): Promise<string | null>;
  setAction(
    id: string | null,
    partial: Partial<Omit<ActionMapping, 'id'>>,
  ): Promise<{ ok: boolean; mapping?: ActionMapping; error?: string }>;
  removeAction(id: string): Promise<boolean>;

  // ── Key recording (main-process uiohook) ──
  startRecording(actionId: string): Promise<void>;
  cancelRecording(): Promise<void>;
  onKeyRecorded(callback: (data: ActionKeyRecorded) => void): void;
  offKeyRecorded(): void;

  // ── Factory reset ──
  resetConfig(): Promise<boolean>;

  // ── Idle animation ──
  setIdleAction(actionId: string | null): Promise<boolean>;
}

/**
 * What the settings window receives via invoke('knife:settings-get').
 * This is a subset of AppConfig (the full type lives in main/config.ts) so
 * the shared layer stays dependency-free.
 */
export interface AppConfigSnapshot {
  version: number;
  retriggerMode: RetriggerMode;
  overlayEnabled: boolean;
  inspectionDurationMs: number;
  knifeDisplaySize: number;
  offsetX: number;
  offsetY: number;
  smoothingLevel: number;
  hideSystemCursor: boolean;
  customSkinPath: string | null;
  actionMappings: ActionMapping[];
}

/* ── Runtime value guards ── */

export function isInspectionFinished(
  value: unknown,
): value is InspectionFinished {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as InspectionFinished).instanceId === 'number' &&
    typeof (value as InspectionFinished).reason === 'string'
  );
}

export function isCursorUpdate(value: unknown): value is CursorUpdate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CursorUpdate).x === 'number' &&
    typeof (value as CursorUpdate).y === 'number'
  );
}

export function generateActionId(): string {
  // A short unique-enough id — runs in any process including the renderer.
  const buf = new Uint8Array(16);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    // Fallback for environments where crypto is unavailable (shouldn't happen).
    for (let i = 0; i < 16; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }

  const h = (n: number) => n.toString(16).padStart(2, '0');
  const hex = Array.from(buf, h).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}