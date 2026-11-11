import type { KnifeCursorApi, SettingsApi } from './shared/ipc';

declare global {
  interface Window {
    knifeCursor?: KnifeCursorApi;
    knifeSettings?: SettingsApi;
  }
}

export {};