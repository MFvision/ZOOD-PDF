/**
 * Keeps a shortcut from running twice in the macOS app, where the same key is
 * both a menu accelerator and something the page listens for.
 *
 * WebKit gives the page the first look at a key equivalent: if a keydown
 * handler calls `preventDefault()`, the menu bar never sees the key; if not,
 * WebKit sends it on and the menu item fires. So by construction exactly one
 * of them runs. This is the second line: a menu event that arrives just after
 * the page has already handled the same combination is an echo, and dropped.
 */

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

/** The key itself, as the menu model writes it: "Z", "=", "-", ",", "1", "F4". */
function baseKey(event: KeyLike): string {
  const code = event.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (code === 'Equal' || code === 'NumpadAdd') return '=';
  if (code === 'Minus' || code === 'NumpadSubtract') return '-';
  if (code === 'Comma') return ',';
  if (/^F\d{1,2}$/.test(code)) return code;
  const key = event.key === '+' ? '=' : event.key;
  return key.length === 1 ? key.toUpperCase() : key;
}

/** A keydown as the model's `keys` ("Mod+Shift+Z"). On Apple platforms Mod is ⌘, elsewhere Ctrl. */
export function comboOf(event: KeyLike, apple: boolean): string {
  const modifiers = new Set<string>();
  if (apple ? event.metaKey : event.ctrlKey) modifiers.add('Mod');
  if (apple && event.ctrlKey) modifiers.add('Ctrl');
  if (event.altKey) modifiers.add('Alt');
  if (event.shiftKey) modifiers.add('Shift');
  return [...ORDER.filter((name) => modifiers.has(name)), baseKey(event)].join('+');
}

/** `keys` written in one order, so "Shift+Mod+Z" and "Mod+Shift+Z" compare equal. */
export function normalizeKeys(keys: string): string {
  const parts = keys.split('+').filter(Boolean);
  const key = parts.pop() ?? '';
  return [...ORDER.filter((name) => parts.includes(name)), key.length === 1 ? key.toUpperCase() : key].join('+');
}

export interface Handled {
  keys: string;
  at: number;
}

/** How long after the page handled a combination a menu event for it is still its echo. */
export const ECHO_WINDOW_MS = 500;

/** Whether a menu item's event is the echo of a key the page already handled. */
export function isEcho(handled: Handled | null, itemKeys: string | undefined, now: number): boolean {
  if (!handled || !itemKeys) return false;
  return normalizeKeys(itemKeys) === handled.keys && now - handled.at >= 0 && now - handled.at < ECHO_WINDOW_MS;
}
