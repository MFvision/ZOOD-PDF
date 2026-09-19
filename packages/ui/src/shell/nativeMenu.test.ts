import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatShortcut, toAccelerator } from './menuModel';
import { ECHO_WINDOW_MS, comboOf, isEcho, normalizeKeys, shortcutLetter } from './shortcutEcho';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('shortcuts as each platform writes them', () => {
  it('puts Apple modifier glyphs first, in the system order, with no separators', () => {
    expect(formatShortcut('Mod+Shift+Z', true)).toBe('⇧⌘Z');
    expect(formatShortcut('Mod+O', true)).toBe('⌘O');
    expect(formatShortcut('Mod+=', true)).toBe('⌘=');
    expect(formatShortcut('Mod+,', true)).toBe('⌘,');
    expect(formatShortcut('Shift+F4', true)).toBe('⇧F4');
    expect(formatShortcut('F4', true)).toBe('F4');
  });

  it('spells modifiers out elsewhere, with Ctrl for Mod', () => {
    expect(formatShortcut('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(formatShortcut('Mod+-', false)).toBe('Ctrl+-');
    expect(formatShortcut('F4', false)).toBe('F4');
  });

  it('turns the model’s keys into Tauri accelerators', () => {
    expect(toAccelerator('Mod+Shift+N')).toBe('CmdOrCtrl+Shift+N');
    expect(toAccelerator('Mod+=')).toBe('CmdOrCtrl+=');
    expect(toAccelerator('Shift+F4')).toBe('Shift+F4');
  });
});

describe('the macOS menu bar the host builds', () => {
  // The Rust side parses every accelerator in this fixture the way Tauri does
  // (apps/desktop/src-tauri/src/menu.rs, `every_accelerator_parses`). Here the
  // fixture is held to the model, so a shortcut added to one is added to both.
  it('has a fixture with exactly the model’s accelerators', () => {
    const model = read('./menuModel.ts');
    const fromModel = [...model.matchAll(/keys: '([^']+)'/g)].map((match) => toAccelerator(match[1]!));
    const fixture = JSON.parse(read('../../../../apps/desktop/src-tauri/tests/menu_spec.json')) as {
      menus: { items: { accelerator?: string }[] }[];
    };
    const fromFixture = fixture.menus.flatMap((menu) => menu.items.flatMap((item) => (item.accelerator ? [item.accelerator] : [])));
    expect(new Set(fromFixture)).toEqual(new Set(fromModel));
  });
});

describe('a shortcut runs once', () => {
  const key = (init: Partial<KeyboardEventInit> & { key: string; code: string }) => ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  });

  it('reads a keydown as the model writes keys', () => {
    expect(comboOf(key({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+Z');
    expect(comboOf(key({ key: '+', code: 'Equal', metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+=');
    expect(comboOf(key({ key: 'o', code: 'KeyO', ctrlKey: true }), false)).toBe('Mod+O');
    // Arabic keyboard: the key is a letter of it, the code is still the key's place.
    expect(comboOf(key({ key: 'ئ', code: 'KeyZ', metaKey: true }), true)).toBe('Mod+Z');
    expect(comboOf(key({ key: 'F4', code: 'F4' }), true)).toBe('F4');
  });

  it('drops a menu event that echoes a key the page just handled', () => {
    const handled = { keys: normalizeKeys('Mod+Shift+Z'), at: 1000 };
    expect(isEcho(handled, 'Mod+Shift+Z', 1100)).toBe(true);
    expect(isEcho(handled, 'Shift+Mod+Z', 1100)).toBe(true);
    // Another item, or the same one chosen later with the mouse, runs.
    expect(isEcho(handled, 'Mod+Z', 1100)).toBe(false);
    expect(isEcho(handled, 'Mod+Shift+Z', 1000 + ECHO_WINDOW_MS + 1)).toBe(false);
    expect(isEcho(handled, undefined, 1100)).toBe(false);
    expect(isEcho(null, 'Mod+Shift+Z', 1100)).toBe(false);
  });
});

describe('a shortcut on any keyboard layout', () => {
  const key = (init: { key: string; code: string }) => ({ metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...init });

  it('is the letter marked on the key where it is Latin, and the key’s place where it is not', () => {
    expect(shortcutLetter(key({ key: 'z', code: 'KeyZ' }))).toBe('z');
    expect(shortcutLetter(key({ key: 'Z', code: 'KeyZ' }))).toBe('z');
    // Arabic: the Z key types ئ, the F key ب.
    expect(shortcutLetter(key({ key: 'ئ', code: 'KeyZ' }))).toBe('z');
    expect(shortcutLetter(key({ key: 'ب', code: 'KeyF' }))).toBe('f');
    expect(shortcutLetter(key({ key: '٠', code: 'Digit0' }))).toBe('0');
    // French: the key marked Z sits where QWERTY has W.
    expect(shortcutLetter(key({ key: 'z', code: 'KeyW' }))).toBe('z');
    expect(shortcutLetter(key({ key: ',', code: 'Comma' }))).toBe(',');
  });
});
