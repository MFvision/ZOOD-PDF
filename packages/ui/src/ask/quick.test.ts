import { describe, expect, it } from 'vitest';
import { DEVICE_MODELS, chatModels } from '../ai/device/models';
import { brainChoices } from './settings';
import {
  CERTAIN,
  QUICK_KEYS,
  QUICK_OPTIONS,
  SURE,
  isQuick,
  optionLabel,
  quickDecision,
  quickModel,
  readQuick,
  searchWords,
  tidyChoice,
  tidyNames,
} from './quick';
import type { AskTool } from './plan';
import { ASK_TOOLS } from './plan';

const toolName = (tool: AskTool, lang: 'ar' | 'en') => `${tool}:${lang}`;

describe('the quick lane', () => {
  it('offers every quick tool, and only quick acts are done without the larger model', () => {
    for (const tool of ASK_TOOLS) expect(QUICK_KEYS).toContain(tool);
    expect(isQuick('compress')).toBe(true);
    expect(isQuick('organize')).toBe(true);
    expect(isQuick('undo')).toBe(true);
    for (const key of ['write', 'fill', 'summarize', 'translate', 'show', 'answer'])
      expect(isQuick(key)).toBe(false);
    for (const text of Object.values(QUICK_OPTIONS)) expect(text.length).toBeLessThan(200);
  });

  it('acts when sure, asks between two when not, and hands writing on', () => {
    expect(readQuick([{ key: 'compress', p: 0.9 }])).toEqual({
      kind: 'act',
      key: 'compress',
      p: 0.9,
    });
    expect(
      readQuick([
        { key: 'protect', p: SURE - 0.1 },
        { key: 'numbers', p: 0.3 },
      ]),
    ).toEqual({ kind: 'choose', keys: ['protect', 'numbers'] });
    expect(readQuick([{ key: 'write', p: 0.95 }])).toEqual({ kind: 'model' });
    expect(readQuick([{ key: 'nonsense', p: 1 }])).toEqual({ kind: 'model' });
    expect(readQuick([])).toEqual({ kind: 'model' });
    expect(CERTAIN).toBeGreaterThan(SURE);
    // Keys every object has, and a ranking of the wrong shape, are never a tool to run.
    expect(readQuick([{ key: 'constructor', p: 1 }])).toEqual({ kind: 'model' });
    expect(readQuick([{ key: { toString: 1 } as unknown as string, p: 1 }])).toEqual({ kind: 'model' });
    expect(readQuick([{ key: 'compress', p: Number.NaN }])).toEqual({ kind: 'model' });
    expect(readQuick([{ key: 'protect', p: 0.4 }, { key: 'toString', p: 0.3 }])).toEqual({ kind: 'act', key: 'protect', p: 0.4 });
  });

  it('a tool needs selected files, and replies in the language asked', () => {
    const none = quickDecision('compress', 'صغّر هالملفات', 0, toolName);
    expect(none.act).toBe('answer');
    expect(none.say).toMatch(/حدّد الملفات/);
    const two = quickDecision('compress', 'make these smaller', 2, toolName);
    expect(two).toMatchObject({ act: 'tool', tool: 'compress' });
    expect(two.say).toBe('compress:en: 2 files.');
    expect(quickDecision('sign', 'وقع العقد', 1, toolName).say).toContain('sign:ar');
  });

  it('a find searches for the words after "find" or "دور لي"', () => {
    expect(searchWords("where's the rent contract from last year?")).toBe(
      'rent contract from last year',
    );
    expect(searchWords('دور لي عقد الإيجار')).toBe('عقد الإيجار');
    expect(searchWords('find my passport scan please')).toBe('passport scan');
    expect(searchWords('وين ملف الفاتورة؟')).toBe('ملف الفاتورة');
    expect(searchWords('budget 2026')).toBe('budget 2026');
    const found = quickDecision('find', 'دور لي عقد الإيجار', 0, toolName);
    expect(found).toMatchObject({ act: 'find', query: 'عقد الإيجار' });
  });

  it('a tidy that names its folder and its way needs no decision', async () => {
    const model = { id: 'no-model' } as never;
    await expect(tidyChoice(model, 'organize my Downloads by type', 0)).resolves.toEqual({
      place: 'downloads',
      how: 'type',
    });
    await expect(tidyChoice(model, 'رتب سطح المكتب حسب الشهر', 0)).resolves.toEqual({
      place: 'desktop',
      how: 'month',
    });
    await expect(tidyChoice(model, 'اجمع الفواتير من التنزيلات', 0)).resolves.toEqual({
      place: 'downloads',
      how: 'invoices',
    });
  });

  it('folders get names in the language asked', () => {
    expect(tidyNames('en').invoices).toBe('Invoices');
    expect(tidyNames('ar').invoices).toBe('الفواتير');
    expect(tidyNames('ar').pdf).toContain('PDF');
  });

  it('a choice button names its option', () => {
    expect(optionLabel('compress', 'en', toolName)).toBe('compress:en');
    expect(optionLabel('organize', 'ar', toolName)).toBe('ترتيب الملفات');
    expect(optionLabel('write', 'en', toolName)).toBe('Write it for me');
  });

  it('the decider is in the catalogue, never offered to chat or to decide plans', () => {
    const model = quickModel();
    expect(model?.decides).toBe(true);
    expect(model?.licence).toBe('Apache-2.0');
    expect(chatModels(false)).not.toContain(model);
    expect(brainChoices()).not.toContain(model);
    expect(DEVICE_MODELS.filter((one) => one.decides)).toHaveLength(1);
  });
});
