import './settings.css';
import type {
  ActionKeyRecorded,
  ActionMapping,
  ActionScanResult,
  DisplaySettings,
  SettingsApi,
  SkinSelectionResult,
  SkinState,
} from './shared/ipc';
import { uiohookKeyName, UIOHOOK_KEY_NAME } from './shared/keycodes';

/* ── DOM helpers ── */

function requireElement<T extends HTMLElement>(
  id: string,
  constructor: new (...args: never[]) => T,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing #${id}`);
  }

  return element;
}

/* ── DOM handles ── */

const durationInput = requireElement('duration', HTMLInputElement);
const durationValue = requireElement('duration-value', HTMLOutputElement);
const sizeInput = requireElement('size', HTMLInputElement);
const sizeValue = requireElement('size-value', HTMLOutputElement);
const offsetXInput = requireElement('offset-x', HTMLInputElement);
const offsetXValue = requireElement('offset-x-value', HTMLOutputElement);
const offsetYInput = requireElement('offset-y', HTMLInputElement);
const offsetYValue = requireElement('offset-y-value', HTMLOutputElement);
const smoothingInput = requireElement('smoothing', HTMLInputElement);
const smoothingValue = requireElement('smoothing-value', HTMLOutputElement);
const hideSystemCursorInput = requireElement(
  'hide-system-cursor',
  HTMLInputElement,
);
const resetOffsetsButton = requireElement(
  'reset-offsets',
  HTMLButtonElement,
);
const chooseSkinButton = requireElement('choose-skin', HTMLButtonElement);
const resetSkinButton = requireElement('reset-skin', HTMLButtonElement);
const skinKind = requireElement('skin-kind', HTMLSpanElement);
const skinCurrent = requireElement('skin-current', HTMLParagraphElement);
const status = requireElement('status', HTMLParagraphElement);
const closeButton = requireElement('close', HTMLButtonElement);
const factoryResetButton = requireElement(
  'factory-reset',
  HTMLButtonElement,
);

// ── V2.0 action manager DOM ──

const scanActionsButton = requireElement('scan-actions', HTMLButtonElement);
const refreshActionsButton = requireElement('refresh-actions', HTMLButtonElement);
const actionsRoot = requireElement('actions-root', HTMLParagraphElement);
const actionList = requireElement('action-list', HTMLDivElement);
const actionListEmpty = requireElement('action-list-empty', HTMLDivElement);

/* ── Shared numeric field type ── */

type NumericSettingField =
  | 'inspectionDurationMs'
  | 'knifeDisplaySize'
  | 'offsetX'
  | 'offsetY'
  | 'smoothingLevel';

/* ── Shared state ── */

let changeSequence = 0;
let skinBusy = false;

/* ── V2.0 action manager state ── */

let actions: ActionMapping[] = [];
let actionsDir: string | null = null;
/**
 * actionId that currently has an active "bind key" recording. Only one
 * action can be recording at a time.
 */
let recordingActionId: string | null = null;
/** Which action is currently set as the idle animation. */
let idleActionId: string | null = null;
/** Track a stale scan so we ignore late responses. */
let scanSequence = 0;

/* ── Key-code ↔ display-name mapping ──
 *
 * From V2.0 onwards this is the shared uiohook-napi `UiohookKey` enum
 * (NOT DOM event.keyCode / Windows VK codes).  A single source of truth
 * lives in src/shared/keycodes.ts, imported as UIOHOOK_KEY_NAME / uiohookKeyName.
 */

/**
 * Priority list for auto-assigning keys to newly scanned actions.
 *
 * Values are LABELS, NOT uiohook keycodes.  keycodeForName() looks each one
 * up in UIOHOOK_KEY_NAME.
 */
const KEY_ASSIGN_PRIORITY = [
  'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N',
  'I', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
];

function keycodeForName(name: string): number {
  for (const [code, label] of Object.entries(UIOHOOK_KEY_NAME)) {
    if (label === name) {
      return Number(code);
    }
  }

  return 0;
}

/**
 * Returns the display name for a uiohook keycode. Falls back to an escaped
 * hex string so the user can see something instead of a blank badge.
 */
function keycodeDisplay(keycode: number): string {
  if (keycode === 0) {
    return '(未绑定)';
  }

  return uiohookKeyName(keycode);
}

/* ── Action list helpers ── */

function usedKeycodes(excludeId?: string): Set<number> {
  const set = new Set<number>();
  for (const action of actions) {
    if (action.keycode !== 0 && action.id !== excludeId) {
      set.add(action.keycode);
    }
  }

  return set;
}

function unusedKeyName(): string | null {
  const used = usedKeycodes();
  for (const name of KEY_ASSIGN_PRIORITY) {
    const code = keycodeForName(name);
    if (code !== 0 && !used.has(code)) {
      return name;
    }
  }

  return null;
}

/* ── Status helpers ── */

function describeSettings(settings: DisplaySettings): string {
  return (
    `动画 ${settings.inspectionDurationMs}ms / ` +
    `光标 ${settings.knifeDisplaySize}px / ` +
    `偏移 ${settings.offsetX},${settings.offsetY}px / ` +
    `松紧 ${settings.smoothingLevel} / ` +
    `系统光标${settings.hideSystemCursor ? '隐藏' : '显示'}`
  );
}

function setStatus(
  message: string,
  tone: 'idle' | 'busy' | 'ok' | 'error',
): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── Existing settings renderers ── */

function renderSettings(settings: DisplaySettings): void {
  durationInput.value = String(settings.inspectionDurationMs);
  durationValue.textContent = `${settings.inspectionDurationMs} ms`;

  sizeInput.value = String(settings.knifeDisplaySize);
  sizeValue.textContent = `${settings.knifeDisplaySize} px`;

  offsetXInput.value = String(settings.offsetX);
  offsetXValue.textContent = `${settings.offsetX} px`;

  offsetYInput.value = String(settings.offsetY);
  offsetYValue.textContent = `${settings.offsetY} px`;

  smoothingInput.value = String(settings.smoothingLevel);
  smoothingValue.textContent = String(settings.smoothingLevel);

  hideSystemCursorInput.checked = settings.hideSystemCursor;
}

function renderSkin(skin: SkinState): void {
  const custom = skin.mode === 'custom';
  skinKind.textContent = custom ? '自定义' : '内置';
  skinKind.dataset.mode = custom ? 'custom' : 'builtin';

  if (custom) {
    skinCurrent.textContent =
      `当前素材：自定义素材（${skin.frameCount} 帧）\n` +
      `路径：${skin.customPath ?? '(未知)'}`;
    skinCurrent.dataset.tone = 'ok';
    return;
  }

  if (skin.customPath !== null) {
    skinCurrent.textContent =
      '当前素材：内置素材\n' +
      `已保存的自定义路径不可用：${skin.customPath}` +
      (skin.error === null ? '' : `\n${skin.error}`);
    skinCurrent.dataset.tone = 'error';
    return;
  }

  skinCurrent.textContent = '当前素材：内置素材（编译进应用的默认素材）';
  skinCurrent.dataset.tone = 'idle';
}

function setSkinBusy(busy: boolean): void {
  skinBusy = busy;
  chooseSkinButton.disabled = busy;
  resetSkinButton.disabled = busy;
  chooseSkinButton.textContent = busy ? '正在应用…' : '选择自定义素材文件夹';
}

async function runSkinAction(
  api: SettingsApi,
  action: () => Promise<SkinSelectionResult>,
  busyMessage: string,
): Promise<void> {
  if (skinBusy) {
    return;
  }

  setSkinBusy(true);
  setStatus(busyMessage, 'busy');

  try {
    const result = await action();
    if (result.skin !== null) {
      renderSkin(result.skin);
    }

    if (result.canceled) {
      setStatus('已取消，当前素材未改变。', 'idle');
      return;
    }

    if (result.error !== null) {
      setStatus(`素材未改变：${result.error}`, 'error');
      return;
    }

    if (!result.changed) {
      setStatus('当前已经在使用这套素材。', 'idle');
      return;
    }

    const skin = result.skin;
    if (skin === null) {
      return;
    }

    setStatus(
      skin.mode === 'custom'
        ? `已换皮：${skin.frameCount} 帧自定义素材`
        : '已恢复内置素材',
      'ok',
    );
  } catch (error) {
    console.error('[settings] skin action failed', error);
    setStatus(`素材操作失败：${describeError(error)}`, 'error');
  } finally {
    setSkinBusy(false);
  }
}

/* ── Settings commit ── */

async function commit(
  api: SettingsApi,
  patch: Partial<DisplaySettings>,
  busyMessage = '正在应用…',
): Promise<void> {
  const sequence = ++changeSequence;
  setStatus(busyMessage, 'busy');

  try {
    const current = await api.update(patch);
    if (sequence !== changeSequence) {
      return;
    }

    renderSettings(current);
    setStatus(`已应用并保存 · ${describeSettings(current)}`, 'ok');
  } catch (error) {
    if (sequence !== changeSequence) {
      return;
    }

    console.error('[settings] update failed', error);
    setStatus(`保存失败：${describeError(error)}`, 'error');
  }
}

function bindSlider(
  api: SettingsApi,
  input: HTMLInputElement,
  output: HTMLOutputElement,
  unit: 'ms' | 'px' | '',
  field: NumericSettingField,
): void {
  input.addEventListener('input', () => {
    const value = Number(input.value);
    output.textContent = unit === '' ? String(value) : `${value} ${unit}`;
    void commit(api, { [field]: value });
  });
}

function disableControls(message: string): void {
  durationInput.disabled = true;
  sizeInput.disabled = true;
  offsetXInput.disabled = true;
  offsetYInput.disabled = true;
  smoothingInput.disabled = true;
  hideSystemCursorInput.disabled = true;
  resetOffsetsButton.disabled = true;
  chooseSkinButton.disabled = true;
  resetSkinButton.disabled = true;
  scanActionsButton.disabled = true;
  refreshActionsButton.disabled = true;
  closeButton.disabled = true;
  factoryResetButton.disabled = true;
  setStatus(message, 'error');
}

function disableAllControls(disabled: boolean): void {
  durationInput.disabled = disabled;
  sizeInput.disabled = disabled;
  offsetXInput.disabled = disabled;
  offsetYInput.disabled = disabled;
  smoothingInput.disabled = disabled;
  hideSystemCursorInput.disabled = disabled;
  resetOffsetsButton.disabled = disabled;
  chooseSkinButton.disabled = disabled;
  resetSkinButton.disabled = disabled;
  scanActionsButton.disabled = disabled;
  refreshActionsButton.disabled = disabled;
  closeButton.disabled = disabled;
  factoryResetButton.disabled = disabled;
}

/* ── V2.0 action manager rendering ── */

function setActionsBusy(busy: boolean): void {
  scanActionsButton.disabled = busy;
  refreshActionsButton.disabled = busy;
}

function renderActions(api: SettingsApi): void {
  // Build a snapshot of the recording state so the DOM reflects it.
  const recordingId = recordingActionId;

  // ── Sanitize: filter out ghost entries (empty name, id, or path) and
  // deduplicate by path so a single corrupted config.json doesn't produce
  // blank slots in the UI.
  const dedup = new Set<string>();
  actions = actions.filter((action) => {
    if (
      typeof action.id !== 'string' ||
      action.id.length === 0 ||
      typeof action.name !== 'string' ||
      action.name.trim().length === 0 ||
      typeof action.path !== 'string' ||
      action.path.trim().length === 0
    ) {
      console.warn(
        `[settings] dropping ghost action id=${String(action.id)} name="${String(action.name ?? '')}"`,
      );
      return false;
    }

    const canonPath = action.path.replace(/[/\\]+$/, '').toLowerCase();
    if (dedup.has(canonPath)) {
      console.warn(
        `[settings] dropping duplicate action path="${action.path}"`,
      );
      return false;
    }
    dedup.add(canonPath);
    return true;
  });

  if (actions.length === 0) {
    actionList.replaceChildren();
    actionList.style.display = 'none';
    actionListEmpty.style.display = '';
    return;
  }

  actionListEmpty.style.display = 'none';
  actionList.style.display = '';

  const fragment = document.createDocumentFragment();

  for (const action of actions) {
    const item = document.createElement('div');
    item.className = 'action-item';
    if (recordingId === action.id) {
      item.dataset.recording = 'true';
    }

    // Name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'action-name';
    nameSpan.textContent = action.name;
    nameSpan.title = action.path;
    item.appendChild(nameSpan);

    // Key badge
    const keySpan = document.createElement('span');
    keySpan.className = 'action-key';
    if (action.keycode === 0) {
      keySpan.dataset.unbound = 'true';
    }
    keySpan.textContent = keycodeDisplay(action.keycode);
    item.appendChild(keySpan);

    // Bind button
    const bindBtn = document.createElement('button');
    bindBtn.className = 'action-bind-btn';
    bindBtn.type = 'button';
    if (recordingId === action.id) {
      bindBtn.dataset.recording = 'true';
      bindBtn.textContent = '请按键… (Esc 取消)';
    } else {
      bindBtn.textContent = action.keycode === 0 ? '绑定按键' : '改键';
    }
    bindBtn.addEventListener('click', () => {
      startRecording(api, action.id);
    });
    item.appendChild(bindBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-delete-btn';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '✕';
    deleteBtn.title = '删除此动作';
    deleteBtn.addEventListener('click', () => {
      handleDeleteAction(action.id);
    });
    item.appendChild(deleteBtn);

    // Idle animation button
    const idleBtn = document.createElement('button');
    idleBtn.className = 'action-idle-btn';
    idleBtn.type = 'button';
    idleBtn.textContent = '⭐';
    idleBtn.title =
      action.id === idleActionId
        ? '当前待机动画（点击取消）'
        : '设为待机动画';
    idleBtn.dataset.active =
      action.id === idleActionId ? 'true' : 'false';
    idleBtn.addEventListener('click', () => {
      handleSetIdleAction(api, action.id);
    });
    item.appendChild(idleBtn);

    fragment.appendChild(item);
  }

  actionList.replaceChildren(fragment);
}

function setActionsError(message: string): void {
  actionsRoot.textContent = '';
  actionList.replaceChildren();
  actionList.style.display = 'none';
  actionListEmpty.style.display = '';

  const errorEl = document.createElement('p');
  errorEl.className = 'action-list-error';
  errorEl.textContent = message;
  actionList.replaceChildren(errorEl);
  actionList.style.display = '';
}

/* ── Key recording (main-process uiohook) ── */

function cancelRecording(api: SettingsApi): void {
  recordingActionId = null;
  void api.cancelRecording();
  renderActions(api);
}

function startRecording(api: SettingsApi, actionId: string): void {
  // If the same action is already recording, toggle off.
  if (recordingActionId === actionId) {
    cancelRecording(api);
    setStatus('已取消按键绑定。', 'idle');
    return;
  }

  // Switch recording to the new action card and tell the main process
  // to intercept the very next uiohook keydown.
  recordingActionId = actionId;
  void api.startRecording(actionId);
  renderActions(api);
  setStatus(`正在为 ${actionName(actionId)} 录制按键… 按任意键或 Esc 取消`, 'busy');
}

function actionName(actionId: string): string {
  for (const action of actions) {
    if (action.id === actionId) {
      return action.name;
    }
  }

  return '(未知动作)';
}

/**
 * Called back by the main process when the user presses a physical key
 * during uiohook recording mode.  The keycode is a real uiohook-napi code.
 */
async function handleActionKeyRecorded(
  api: SettingsApi,
  data: ActionKeyRecorded,
): Promise<void> {
  if (recordingActionId === null || recordingActionId !== data.actionId) {
    // Stale callback — ignore.
    return;
  }

  const actionId = data.actionId;
  const keycode = data.keycode;
  const displayName = data.keyName;

  recordingActionId = null;

  // Conflict check.
  const conflict = actions.find(
    (action) => action.id !== actionId && action.keycode === keycode,
  );
  if (conflict !== undefined) {
    setStatus(
      `❌ 按键冲突：${displayName} 已被“${conflict.name}”占用，请重新录制或 Esc 取消。`,
      'error',
    );
    renderActions(api);
    return;
  }

  const action = actions.find((a) => a.id === actionId);
  const actionDisplayName = action?.name ?? '(未知动作)';

  setStatus(`正在保存 ${actionDisplayName} → ${displayName}…`, 'busy');
  renderActions(api);
  setActionsBusy(true);

  try {
    const result = await api.setAction(actionId, {
      keycode,
      keyName: displayName,
    });

    if (!result.ok) {
      setStatus(
        `保存失败：${result.error ?? '未知错误'}（已绑定到 ${displayName}，但未持久化）`,
        'error',
      );
      return;
    }

    // Apply the change in our local list immediately.
    for (let i = 0; i < actions.length; i++) {
      if (actions[i].id === actionId) {
        actions[i] = { ...actions[i], keycode, keyName: displayName };
        break;
      }
    }

    renderActions(api);
    setStatus(
      `✅ ${actionDisplayName} 已绑定到 ${displayName}`,
      'ok',
    );
  } catch (error) {
    console.error('[settings] setAction failed', error);
    setStatus(`保存失败：${describeError(error)}`, 'error');
  } finally {
    setActionsBusy(false);
  }
}

/* ── Action scan ── */

async function handleScanActions(api: SettingsApi): Promise<void> {
  setActionsBusy(true);
  setStatus('正在打开目录选择器…', 'busy');

  const sequence = ++scanSequence;

  try {
    const dir = await api.chooseActionRootDirectory();
    if (sequence !== scanSequence) {
      return;
    }

    if (dir === null) {
      setStatus('已取消扫描。', 'idle');
      setActionsBusy(false);
      return;
    }

    actionsDir = dir;
    actionsRoot.textContent = `根目录：${dir}`;
    setStatus(`正在扫描 ${dir} …`, 'busy');

    const result = await api.scanRootDirectory(dir);
    if (sequence !== scanSequence) {
      return;
    }

    if (!result.ok) {
      setActionsBusy(false);
      setActionsError(
        result.error !== null
          ? `扫描失败：${result.error}`
          : '扫描失败，路径中未找到包含帧图片的子文件夹。',
      );
      setStatus(`扫描 ${dir} 失败`, 'error');
      return;
    }

    if (result.candidates.length === 0) {
      setActionsBusy(false);
      setActionsError(
        `${dir} 下未找到包含 frame_*.png 的子文件夹。\n每个动作文件夹内至少需要一个帧文件。`,
      );
      setStatus('扫描完成，但未找到任何候选动作。', 'idle');
      return;
    }

    // Build a set of already-known folder names (normalized to basename).
    const existingNames = new Set(
      actions.map((action) => {
        const parts = action.path.replace(/[/\\]+$/, '').split(/[/\\]/);
        return parts[parts.length - 1]?.toLowerCase() ?? '';
      }),
    );

    const newMappings: ActionMapping[] = [];
    for (const candidate of result.candidates) {
      const normalized = candidate.toLowerCase();
      if (existingNames.has(normalized)) {
        continue;
      }

      // Auto-assign a key if one is available.
      let assignedKeycode = 0;
      let assignedKeyName = '(未绑定)';
      const autoName = unusedKeyName();

      // Recompute used keycodes including in-flight new mappings.
      const allUsed = usedKeycodes();
      for (const nm of newMappings) {
        if (nm.keycode !== 0) {
          allUsed.add(nm.keycode);
        }
      }

      if (autoName !== null) {
        const code = keycodeForName(autoName);
        if (code !== 0 && !allUsed.has(code)) {
          assignedKeycode = code;
          assignedKeyName = autoName;
          allUsed.add(code);
        }
      }

      const fullPath =
        result.rootPath.replace(/[/\\]+$/, '') +
        '\\' +
        candidate;

      // Build a spec without an id so the main process generates one.
      newMappings.push({
        id: '', // unused — main process allocates the real id
        name: candidate,
        path: fullPath,
        keycode: assignedKeycode,
        keyName: assignedKeyName,
        modifiers: 0,
      });
    }

    // Persist new mappings through the main process, even without a bound key.
    if (newMappings.length > 0) {
      setStatus(
        `正在添加 ${newMappings.length} 个新动作…`,
        'busy',
      );

      const persistedMappings: ActionMapping[] = [];
      let addErrors = 0;
      for (const mapping of newMappings) {
        try {
          // IMPORTANT: pass null so setActionMapping allocates a fresh
          // uuid in the main process, keeping ids consistent.
          const result = await api.setAction(null, {
            name: mapping.name,
            path: mapping.path,
            keycode: mapping.keycode,
            keyName: mapping.keyName,
            modifiers: mapping.modifiers,
          });

          if (!result.ok) {
            addErrors++;
            console.error(
              `[settings] failed to persist action ${mapping.name}:`,
              result.error,
            );
            continue;
          }

          // Use the mapping returned by the main process — it carries the
          // REAL uuid allocated by setActionMapping.
          if (result.mapping !== undefined) {
            persistedMappings.push(result.mapping);
          }
        } catch (error) {
          addErrors++;
          console.error(
            `[settings] crash persisting action ${mapping.name}:`,
            describeError(error),
          );
        }
      }

      // Only add persisted (successful) mappings to the local list so
      // the ids stay in sync with the main process.
      actions.push(...persistedMappings);
    }

    if (newMappings.length === 0) {
      setStatus('扫描完成，所有子文件夹都已存在。', 'idle');
    } else if (newMappings.length === 1) {
      setStatus(
        `✅ 已添加“${newMappings[0].name}”${newMappings[0].keycode !== 0 ? `（${newMappings[0].keyName}）` : ''}`,
        'ok',
      );
    } else {
      setStatus(
        `✅ 已添加 ${newMappings.length} 个新动作`,
        'ok',
      );
    }

    renderActions(api);
  } catch (error) {
    if (sequence !== scanSequence) {
      return;
    }

    console.error('[settings] scan failed', error);
    setStatus(`扫描失败：${describeError(error)}`, 'error');
  } finally {
    if (sequence === scanSequence) {
      setActionsBusy(false);
    }
  }
}

/* ── Action delete ── */

async function handleSetIdleAction(
  api: SettingsApi,
  actionId: string,
): Promise<void> {
  // Toggle: if already active, set to null (cancel).
  const newId = idleActionId === actionId ? null : actionId;
  setActionsBusy(true);
  try {
    const result = await api.setIdleAction(newId);
    if (result.ok) {
      idleActionId = newId;
      renderActions(api);
    } else {
      setActionsError(result.error ?? '设置待机动画失败');
    }
  } catch (err) {
    setActionsError(
      `设置待机动画异常: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    setActionsBusy(false);
  }
}

async function handleDeleteAction(actionId: string): Promise<void> {
  const api = window.knifeSettings;
  if (!api) {
    return;
  }

  const action = actions.find((a) => a.id === actionId);
  if (action === undefined) {
    return;
  }

  // If this action is currently recording, stop.
  if (recordingActionId === actionId) {
    recordingActionId = null;
  }

  setStatus(`正在删除“${action.name}”…`, 'busy');
  setActionsBusy(true);

  try {
    const ok = await api.removeAction(actionId);
    if (!ok) {
      setStatus(`删除“${action.name}”失败。`, 'error');
      return;
    }

    actions = actions.filter((a) => a.id !== actionId);
    renderActions(api);
    setStatus(`已删除“${action.name}”。`, 'ok');
  } catch (error) {
    console.error('[settings] delete action failed', error);
    setStatus(`删除失败：${describeError(error)}`, 'error');
  } finally {
    setActionsBusy(false);
  }
}

/* ── Action refresh ── */

async function handleRefreshActions(api: SettingsApi): Promise<void> {
  setActionsBusy(true);
  setStatus('正在刷新动作列表…', 'busy');

  try {
    const list = await api.listActions();
    actions = list;
    renderActions(api);
    setStatus('动作列表已刷新。', 'ok');
  } catch (error) {
    console.error('[settings] refresh actions failed', error);
    setStatus(`刷新失败：${describeError(error)}`, 'error');
  } finally {
    setActionsBusy(false);
  }
}

/* ── 恢复出厂设置 ── */

async function handleFactoryReset(api: SettingsApi): Promise<void> {
  // Electronic confirmation before nuking all data.
  const confirmed = window.confirm(
    '确定要清除所有动作绑定、自定义路径和参数，恢复默认状态吗？\n\n' +
    '此操作不可撤销。',
  );

  if (!confirmed) {
    return;
  }

  setStatus('正在恢复出厂设置…', 'busy');
  disableAllControls(true);

  try {
    const ok = await api.resetConfig();

    if (!ok) {
      setStatus('恢复出厂设置失败，请检查日志。', 'error');
      disableAllControls(false);
      return;
    }

    // Reset local state so the page reflects defaults immediately.
    actions = [];
    actionsDir = null;
    recordingActionId = null;
    actionsRoot.textContent = '';
    renderActions(api);

    // Reload config to pull the freshly-written defaults.
    const settings = await api.get();
    renderSettings(settings);
    renderSkin({
      mode: 'builtin',
      customPath: null,
      frameCount: 0,
      idleUrl: null,
      frameUrls: [],
      error: null,
    });

    setStatus('已恢复出厂设置。', 'ok');

    console.log('[settings] factory reset applied');
  } catch (error) {
    console.error('[settings] factory reset failed', error);
    setStatus(`恢复出厂设置失败：${describeError(error)}`, 'error');
  } finally {
    disableAllControls(false);
  }
}

/* ── Boot ── */

async function boot(): Promise<void> {
  const api = window.knifeSettings;
  if (!api) {
    disableControls('设置桥接不可用：preload 未加载。');
    return;
  }

  bindSlider(api, durationInput, durationValue, 'ms', 'inspectionDurationMs');
  bindSlider(api, sizeInput, sizeValue, 'px', 'knifeDisplaySize');
  bindSlider(api, offsetXInput, offsetXValue, 'px', 'offsetX');
  bindSlider(api, offsetYInput, offsetYValue, 'px', 'offsetY');
  bindSlider(api, smoothingInput, smoothingValue, '', 'smoothingLevel');

  hideSystemCursorInput.addEventListener('change', () => {
    const hidden = hideSystemCursorInput.checked;
    void commit(
      api,
      { hideSystemCursor: hidden },
      hidden ? '正在隐藏系统光标…' : '正在恢复系统光标…',
    );
  });

  resetOffsetsButton.addEventListener('click', () => {
    offsetXInput.value = '0';
    offsetYInput.value = '0';
    offsetXValue.textContent = '0 px';
    offsetYValue.textContent = '0 px';
    void commit(api, { offsetX: 0, offsetY: 0 });
  });

  chooseSkinButton.addEventListener('click', () => {
    void runSkinAction(
      api,
      () => api.chooseSkin(),
      '正在打开素材文件夹…',
    );
  });

  resetSkinButton.addEventListener('click', () => {
    void runSkinAction(
      api,
      () => api.resetSkin(),
      '正在恢复内置素材…',
    );
  });

  closeButton.addEventListener('click', () => {
    window.close();
  });

  factoryResetButton.addEventListener('click', () => {
    void handleFactoryReset(api);
  });

  // ── V2.0 action manager ──

  scanActionsButton.addEventListener('click', () => {
    void handleScanActions(api);
  });

  refreshActionsButton.addEventListener('click', () => {
    void handleRefreshActions(api);
  });

  // ── Key recording listener (main-process uiohook) ──
  // When the user starts recording by clicking "改键", the main process
  // arms uiohook to capture the very next keydown.  The resulting uiohook
  // keycode is delivered here via IPC — NO DOM keyCode translation needed.
  api.onKeyRecorded((data) => {
    void handleActionKeyRecorded(api, data);
  });

  try {
    const [settings, skin, actionMappings] = await Promise.all([
      api.get(),
      api.getSkin(),
      api.listActions(),
    ]);

    renderSettings(settings);
    renderSkin(skin);

    actions = actionMappings;
    if (actions.length > 0) {
      // Heuristic: use the first action's parent directory as the root hint.
      const firstPath = actions[0].path
        .replace(/[/\\]+$/, '')
        .replace(/[/\\][^/\\]+$/, '');
      if (firstPath.length > 0) {
        actionsDir = firstPath;
        actionsRoot.textContent = `根目录：${firstPath}`;
      }
    }
    renderActions(api);

    if (skin.error !== null) {
      setStatus(`已加载，但自定义素材不可用：${skin.error}`, 'error');
    } else if (actions.length > 0) {
      setStatus(
        `已加载 · ${describeSettings(settings)} · ${actions.length} 个动作`,
        'idle',
      );
    } else {
      setStatus(`已加载 · ${describeSettings(settings)}`, 'idle');
    }

    console.log(
      `[settings] loaded ${describeSettings(settings)} ` +
        `skin=${skin.mode} frames=${skin.frameCount} ` +
        `actions=${actions.length}`,
    );
  } catch (error) {
    console.error('[settings] initial load failed', error);
    disableControls(`读取配置失败：${describeError(error)}`);
  }
}

void boot();