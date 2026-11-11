import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, SETTINGS_WINDOW_ARG } from './shared/ipc';
import type {
  ActionKeyRecorded,
  ActionMapping,
  ActionScanResult,
  ActiveActionData,
  CursorUpdate,
  DisplaySettings,
  IdleAnimationData,
  InspectionFinished,
  InspectionReset,
  InspectionStart,
  KnifeCursorApi,
  SettingsApi,
  SkinState,
} from './shared/ipc';

type CursorListener = (event: IpcRendererEvent, update: CursorUpdate) => void;
type InspectionStartListener = (
  event: IpcRendererEvent,
  start: InspectionStart,
) => void;
type InspectionResetListener = (
  event: IpcRendererEvent,
  reset: InspectionReset,
) => void;
type DisplaySettingsListener = (
  event: IpcRendererEvent,
  settings: DisplaySettings,
) => void;
type SkinChangedListener = (event: IpcRendererEvent, skin: SkinState) => void;
type ActionActivatedListener = (
  event: IpcRendererEvent,
  data: ActiveActionData,
) => void;
type IdleAnimationListener = (
  event: IpcRendererEvent,
  data: IdleAnimationData,
) => void;

let cursorListener: CursorListener | null = null;
let inspectionStartListener: InspectionStartListener | null = null;
let inspectionResetListener: InspectionResetListener | null = null;
let displaySettingsListener: DisplaySettingsListener | null = null;
let skinChangedListener: SkinChangedListener | null = null;
let actionActivatedListener: ActionActivatedListener | null = null;
let actionKeyRecordedListener: ((_event: IpcRendererEvent, data: ActionKeyRecorded) => void) | null = null;
let idleAnimationChangedListener: IdleAnimationListener | null = null;

const api: KnifeCursorApi = {
  onCursorUpdate(callback) {
    if (cursorListener !== null) {
      ipcRenderer.removeListener(IPC_CHANNELS.cursorUpdate, cursorListener);
    }

    cursorListener = (_event, update) => {
      callback(update);
    };
    ipcRenderer.on(IPC_CHANNELS.cursorUpdate, cursorListener);
  },

  offCursorUpdate() {
    if (cursorListener === null) {
      return;
    }

    ipcRenderer.removeListener(IPC_CHANNELS.cursorUpdate, cursorListener);
    cursorListener = null;
  },

  onInspectionStart(callback) {
    if (inspectionStartListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.inspectionStart,
        inspectionStartListener,
      );
    }

    inspectionStartListener = (_event, start) => {
      callback(start);
    };
    ipcRenderer.on(IPC_CHANNELS.inspectionStart, inspectionStartListener);
  },

  offInspectionStart() {
    if (inspectionStartListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.inspectionStart,
      inspectionStartListener,
    );
    inspectionStartListener = null;
  },

  onInspectionReset(callback) {
    if (inspectionResetListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.inspectionReset,
        inspectionResetListener,
      );
    }

    inspectionResetListener = (_event, reset) => {
      callback(reset);
    };
    ipcRenderer.on(IPC_CHANNELS.inspectionReset, inspectionResetListener);
  },

  offInspectionReset() {
    if (inspectionResetListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.inspectionReset,
      inspectionResetListener,
    );
    inspectionResetListener = null;
  },

  onDisplaySettings(callback) {
    if (displaySettingsListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.displaySettings,
        displaySettingsListener,
      );
    }

    displaySettingsListener = (_event, settings) => {
      callback(settings);
    };
    ipcRenderer.on(IPC_CHANNELS.displaySettings, displaySettingsListener);
  },

  offDisplaySettings() {
    if (displaySettingsListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.displaySettings,
      displaySettingsListener,
    );
    displaySettingsListener = null;
  },

  onSkinChanged(callback) {
    if (skinChangedListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.skinChanged,
        skinChangedListener,
      );
    }

    skinChangedListener = (_event, skin) => {
      callback(skin);
    };
    ipcRenderer.on(IPC_CHANNELS.skinChanged, skinChangedListener);
  },

  offSkinChanged() {
    if (skinChangedListener === null) {
      return;
    }

    ipcRenderer.removeListener(IPC_CHANNELS.skinChanged, skinChangedListener);
    skinChangedListener = null;
  },

  // ── V2.0 动作激活 ──
  onActionActivated(callback) {
    if (actionActivatedListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.actionActivated,
        actionActivatedListener,
      );
    }

    actionActivatedListener = (_event, data) => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.actionActivated, actionActivatedListener);
  },

  offActionActivated() {
    if (actionActivatedListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.actionActivated,
      actionActivatedListener,
    );
    actionActivatedListener = null;
  },

  onIdleAnimationChanged(callback) {
    if (idleAnimationChangedListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.idleAnimationChanged,
        idleAnimationChangedListener,
      );
    }

    idleAnimationChangedListener = (_event, data) => {
      callback(data);
    };
    ipcRenderer.on(
      IPC_CHANNELS.idleAnimationChanged,
      idleAnimationChangedListener,
    );
  },

  offIdleAnimationChanged() {
    if (idleAnimationChangedListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.idleAnimationChanged,
      idleAnimationChangedListener,
    );
    idleAnimationChangedListener = null;
  },

  notifyInspectionFinished(finished: InspectionFinished) {
    ipcRenderer.send(IPC_CHANNELS.inspectionFinished, finished);
  },
};

const settingsApi: SettingsApi = {
  get() {
    return ipcRenderer.invoke(IPC_CHANNELS.settingsGet);
  },

  update(patch) {
    return ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch);
  },

  getSkin() {
    return ipcRenderer.invoke(IPC_CHANNELS.skinGet);
  },

  chooseSkin() {
    return ipcRenderer.invoke(IPC_CHANNELS.skinChoose);
  },

  resetSkin() {
    return ipcRenderer.invoke(IPC_CHANNELS.skinReset);
  },

  // ── V2.0 动作管理 ──
  listActions() {
    return ipcRenderer.invoke(IPC_CHANNELS.actionsList);
  },

  scanRootDirectory(rootPath: string) {
    return ipcRenderer.invoke(IPC_CHANNELS.actionsScan, rootPath);
  },

  chooseActionRootDirectory() {
    return ipcRenderer.invoke(IPC_CHANNELS.actionsChooseRoot);
  },

  async setAction(
    id: string | null,
    partial: Partial<Omit<ActionMapping, 'id'>>,
  ): Promise<{ ok: boolean; mapping?: ActionMapping; error?: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.actionsSet, { id, ...partial });
  },

  removeAction(id: string) {
    return ipcRenderer.invoke(IPC_CHANNELS.actionsRemove, id);
  },

  // ── Key recording (main-process uiohook) ──
  startRecording(actionId: string) {
    return ipcRenderer.invoke(
      IPC_CHANNELS.actionsStartRecording,
      actionId,
    );
  },

  cancelRecording() {
    return ipcRenderer.invoke(IPC_CHANNELS.actionsCancelRecording);
  },

  onKeyRecorded(callback) {
    if (actionKeyRecordedListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.actionKeyRecorded,
        actionKeyRecordedListener,
      );
    }

    actionKeyRecordedListener = (_event, data) => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.actionKeyRecorded, actionKeyRecordedListener);
  },

  offKeyRecorded() {
    if (actionKeyRecordedListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.actionKeyRecorded,
      actionKeyRecordedListener,
    );
    actionKeyRecordedListener = null;
  },

  resetConfig(): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.actionsReset);
  },

  setIdleAction(actionId: string | null): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.actionsSetIdle, actionId);
  },
};

// The overlay and the settings window share one preload bundle. Only expose the
// privileged settings bridge to the window that main explicitly tagged.
if (process.argv.includes(SETTINGS_WINDOW_ARG)) {
  contextBridge.exposeInMainWorld('knifeSettings', settingsApi);
} else {
  contextBridge.exposeInMainWorld('knifeCursor', api);
}