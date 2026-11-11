import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_HIDE_SYSTEM_CURSOR,
  DEFAULT_INSPECTION_DURATION_MS,
  DEFAULT_KNIFE_DISPLAY_SIZE,
  DEFAULT_OFFSET,
  DEFAULT_SMOOTHING_LEVEL,
  INSPECTION_DURATION_STEP_MS,
  KNIFE_DISPLAY_SIZE_STEP,
  MAX_INSPECTION_DURATION_MS,
  MAX_KNIFE_DISPLAY_SIZE,
  MAX_OFFSET,
  MAX_SMOOTHING_LEVEL,
  MIN_INSPECTION_DURATION_MS,
  MIN_KNIFE_DISPLAY_SIZE,
  MIN_OFFSET,
  MIN_SMOOTHING_LEVEL,
  OFFSET_STEP,
  SMOOTHING_LEVEL_STEP,
} from '../shared/ipc';
import type {
  ActionMapping,
  DisplaySettings,
  RetriggerMode,
} from '../shared/ipc';

export type { ActionMapping } from '../shared/ipc';

export interface AppConfig extends DisplaySettings {
  version: 1;
  retriggerMode: RetriggerMode;
  overlayEnabled: boolean;
  /** Absolute folder selected in Settings; null means built-in artwork. */
  customSkinPath: string | null;
  /** V2.0: per-key action mappings. */
  actionMappings: ActionMapping[];
  /** V2.0: action id that serves as the idle loop animation (null = static idle.png). */
  idleActionId: string | null;
}

export interface ConfigLoadResult {
  config: AppConfig;
  warning: string | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  retriggerMode: 'ignore',
  overlayEnabled: true,
  inspectionDurationMs: DEFAULT_INSPECTION_DURATION_MS,
  knifeDisplaySize: DEFAULT_KNIFE_DISPLAY_SIZE,
  offsetX: DEFAULT_OFFSET,
  offsetY: DEFAULT_OFFSET,
  smoothingLevel: DEFAULT_SMOOTHING_LEVEL,
  hideSystemCursor: DEFAULT_HIDE_SYSTEM_CURSOR,
  customSkinPath: null,
  actionMappings: [],
  idleActionId: null,
};

export function isRetriggerMode(value: unknown): value is RetriggerMode {
  return value === 'ignore' || value === 'restart';
}

function snapToStep(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  step: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const clamped = Math.min(max, Math.max(min, value));
  const snapped = min + Math.round((clamped - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

export function normalizeInspectionDuration(value: unknown): number {
  return snapToStep(
    value,
    DEFAULT_INSPECTION_DURATION_MS,
    MIN_INSPECTION_DURATION_MS,
    MAX_INSPECTION_DURATION_MS,
    INSPECTION_DURATION_STEP_MS,
  );
}

export function normalizeKnifeDisplaySize(value: unknown): number {
  return snapToStep(
    value,
    DEFAULT_KNIFE_DISPLAY_SIZE,
    MIN_KNIFE_DISPLAY_SIZE,
    MAX_KNIFE_DISPLAY_SIZE,
    KNIFE_DISPLAY_SIZE_STEP,
  );
}

/** Hotspot offset in CSS pixels; clamped to the same range as the sliders. */
export function normalizeOffset(value: unknown): number {
  return snapToStep(
    value,
    DEFAULT_OFFSET,
    MIN_OFFSET,
    MAX_OFFSET,
    OFFSET_STEP,
  );
}

export function normalizeSmoothingLevel(value: unknown): number {
  return snapToStep(
    value,
    DEFAULT_SMOOTHING_LEVEL,
    MIN_SMOOTHING_LEVEL,
    MAX_SMOOTHING_LEVEL,
    SMOOTHING_LEVEL_STEP,
  );
}

// ── V2.0 动作映射归一化 ──

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accept an arbitrary object from config.json and coerce it into a valid
 * ActionMapping.  Missing or invalid fields fall back to empty/zero so a
 * hand-edited config never crashes the app.
 */
function normalizeActionMapping(raw: unknown): ActionMapping | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  const id = isString(raw.id) && raw.id.length > 0 ? raw.id : '';
  const name = isString(raw.name) ? raw.name.trim() : '';
  const p = isString(raw.path) ? raw.path.trim() : '';
  const keycode = isNumber(raw.keycode) ? Math.round(raw.keycode) : 0;
  const keyName = isString(raw.keyName) ? raw.keyName.trim() : '';
  const modifiers = isNumber(raw.modifiers)
    ? Math.max(0, Math.round(raw.modifiers))
    : 0;

  // An action without an id is not usable.
  if (id.length === 0) {
    return null;
  }

  return { id, name, path: p, keycode, keyName, modifiers };
}

function normalizeActionMappings(raw: unknown): ActionMapping[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const result: ActionMapping[] = [];

  for (const entry of raw) {
    const mapping = normalizeActionMapping(entry);
    if (mapping === null || seen.has(mapping.id)) {
      continue;
    }

    seen.add(mapping.id);
    result.push(mapping);
  }

  return result;
}

function normalizeConfig(value: unknown): AppConfig {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_CONFIG };
  }

  const record = value as Record<string, unknown>;

  return {
    version: 1,
    retriggerMode: isRetriggerMode(record.retriggerMode)
      ? record.retriggerMode
      : DEFAULT_CONFIG.retriggerMode,
    overlayEnabled:
      typeof record.overlayEnabled === 'boolean'
        ? record.overlayEnabled
        : DEFAULT_CONFIG.overlayEnabled,
    inspectionDurationMs: normalizeInspectionDuration(
      record.inspectionDurationMs,
    ),
    knifeDisplaySize: normalizeKnifeDisplaySize(record.knifeDisplaySize),
    offsetX: normalizeOffset(record.offsetX),
    offsetY: normalizeOffset(record.offsetY),
    smoothingLevel: normalizeSmoothingLevel(record.smoothingLevel),
    hideSystemCursor:
      typeof record.hideSystemCursor === 'boolean'
        ? record.hideSystemCursor
        : DEFAULT_CONFIG.hideSystemCursor,
    customSkinPath:
      typeof record.customSkinPath === 'string' &&
      record.customSkinPath.trim() !== ''
        ? record.customSkinPath
        : null,
    actionMappings: normalizeActionMappings(record.actionMappings),
    idleActionId:
      typeof record.idleActionId === 'string' && record.idleActionId.length > 0
        ? record.idleActionId
        : null,
  };
}

/**
 * Load config from the userData directory. A corrupt or partially written
 * config must never stop the overlay from starting, so parse errors fall back
 * to defaults and are surfaced to the caller for logging.
 *
 * Post-processing:
 *   - Dead action mappings (path empty or directory missing) are silently
 *     pruned so they don't cause frame-missing errors at runtime.
 *   - Removed actions are re-saved to disk so the cleaned config persists.
 */
export function loadConfig(configPath: string): ConfigLoadResult {
  try {
    if (!fs.existsSync(configPath)) {
      return { config: { ...DEFAULT_CONFIG }, warning: null };
    }

    const raw = fs.readFileSync(configPath, 'utf8');
    // Users may edit config.json in an editor that writes a UTF-8 BOM.
    // JSON.parse rejects the BOM, which must not reset every setting.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (parseError) {
      // Corrupted JSON → silently fall back to defaults; write a clean config.
      const msg =
        parseError instanceof Error ? parseError.message : String(parseError);
      console.warn(
        `[config] config.json is corrupted (${msg}), starting with defaults`,
      );
      const defaults = { ...DEFAULT_CONFIG };
      try {
        saveConfig(configPath, defaults);
      } catch {
        // best-effort
      }
      return {
        config: defaults,
        warning: `config.json was corrupted (${msg}); reset to defaults`,
      };
    }

    const config = normalizeConfig(parsed);
    return pruneDeadActions(configPath, config);
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG },
      warning: `could not read ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Remove every ActionMapping whose path is empty or whose directory no longer
 * exists on disk.  If anything was removed, re-save so the cleaned list
 * persists across restarts.
 */
function pruneDeadActions(
  configPath: string,
  config: AppConfig,
): ConfigLoadResult {
  if (config.actionMappings.length === 0) {
    return { config, warning: null };
  }

  const alive: ActionMapping[] = [];
  const removed: string[] = [];

  for (const mapping of config.actionMappings) {
    const p = mapping.path;
    if (p.length === 0) {
      removed.push(
        `id=${mapping.id} name="${mapping.name}" reason=empty-path`,
      );
      continue;
    }

    // Allow both files and directories — a user might point directly at a
    // single PNG folder or a shortcut.  Only prune when the resolved
    // absolute path is definitely absent.
    try {
      if (!fs.existsSync(path.resolve(p))) {
        removed.push(
          `id=${mapping.id} name="${mapping.name}" path="${p}" reason=missing`,
        );
        continue;
      }
    } catch {
      // stat failed (e.g. access denied on a network drive) → keep it;
      // the protocol handler has its own error logging.
    }

    alive.push(mapping);
  }

  if (removed.length > 0) {
    console.warn(`[config] pruned ${removed.length} dead action(s):`);
    for (const r of removed) {
      console.warn(`[config]   ${r}`);
    }

    const cleaned: AppConfig = { ...config, actionMappings: alive };
    try {
      saveConfig(configPath, cleaned);
    } catch {
      // best-effort
    }

    return {
      config: cleaned,
      warning: `pruned ${removed.length} dead action(s) from config.json`,
    };
  }

  return { config, warning: null };
}

/** Reset in-memory config to factory defaults and atomically write to disk. */
export function resetConfigToDefaults(configPath: string): AppConfig {
  const defaults: AppConfig = { ...DEFAULT_CONFIG };
  try {
    saveConfig(configPath, defaults);
  } catch (error) {
    console.error(
      `[config] failed to write reset config: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return defaults;
}

/** Write atomically so a crash cannot leave truncated JSON behind. */
export function saveConfig(configPath: string, config: AppConfig): void {
  const directory = path.dirname(configPath);
  const tempPath = `${configPath}.${process.pid}.tmp`;

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, configPath);
}