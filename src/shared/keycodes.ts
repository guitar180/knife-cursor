/**
 * uiohook-napi keycode ↔ human-readable display name.
 *
 * These values follow the uiohook-napi `UiohookKey` enum — NOT Windows VK
 * codes and NOT DOM `event.keyCode`.  A single source of truth shared
 * between main (which receives raw uiohook events) and settings (which
 * renders the action key badges).
 *
 * Keycode values are Linux input-event codes (uiohook-napi's native layer).
 * Double-check against
 * https://github.com/kwhat/libuiohook/blob/master/include/uiohook.h
 * if a key appears to be missing.
 */

export const UIOHOOK_KEY_NAME: Readonly<Record<number, string>> = {
  // ── Navigation ──
  1: 'Esc',
  14: 'Backspace',
  15: 'Tab',
  28: 'Enter',
  57: 'Space',
  58: 'CapsLock',

  // ── Modifiers ──
  29: 'Ctrl',
  42: 'Shift',
  54: 'RShift',
  56: 'Alt',

  // ── Letters (Q line) ──
  16: 'Q',
  17: 'W',
  18: 'E',
  19: 'R',
  20: 'T',
  21: 'Y',
  22: 'U',
  23: 'I',
  24: 'O',
  25: 'P',

  // ── Letters (A line) ──
  30: 'A',
  31: 'S',
  32: 'D',
  33: 'F',
  34: 'G',
  35: 'H',
  36: 'J',
  37: 'K',
  38: 'L',

  // ── Letters (Z line) ──
  44: 'Z',
  45: 'X',
  46: 'C',
  47: 'V',
  48: 'B',
  49: 'N',
  50: 'M',

  // ── Numbers (main keyboard row) ──
  2: '1',
  3: '2',
  4: '3',
  5: '4',
  6: '5',
  7: '6',
  8: '7',
  9: '8',
  10: '9',
  11: '0',

  // ── Punctuation ──
  12: '-',
  13: '=',
  26: '[',
  27: ']',
  39: ';',
  40: "'",
  41: '`',
  43: '\\',
  51: ',',
  52: '.',
  53: '/',

  // ── Numpad ──
  55: 'Num*',
  71: 'Num7',
  72: 'Num8',
  73: 'Num9',
  74: 'Num-',
  75: 'Num4',
  76: 'Num5',
  77: 'Num6',
  78: 'Num+',
  79: 'Num1',
  80: 'Num2',
  81: 'Num3',
  82: 'Num0',
  83: 'Num.',

  // ── Function keys ──
  59: 'F1',
  60: 'F2',
  61: 'F3',
  62: 'F4',
  63: 'F5',
  64: 'F6',
  65: 'F7',
  66: 'F8',
  67: 'F9',
  68: 'F10',
  87: 'F11',
  88: 'F12',

  // ── Locks ──
  69: 'NumLock',
  70: 'ScrollLock',

  // ── Navigation / editing ──
  99: 'PrintScreen',
  102: 'Home',
  103: '↑',
  104: 'PageUp',
  105: '←',
  106: '→',
  107: 'End',
  108: '↓',
  109: 'PageDown',
  110: 'Insert',
  111: 'Delete',
  119: 'Pause',
};

/**
 * Returns the human-readable key name for a uiohook keycode.
 * Returns a hex fallback for unknown codes.
 */
export function uiohookKeyName(keycode: number): string {
  const name = UIOHOOK_KEY_NAME[keycode];
  if (name !== undefined) {
    return name;
  }

  return `0x${keycode.toString(16).toUpperCase().padStart(2, '0')}`;
}