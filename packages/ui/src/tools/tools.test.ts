import { describe, expect, it } from 'vitest';
import ar from '../i18n/ar.json';
import en from '../i18n/en.json';
import { TOOLS } from './tools';

/**
 * The tool list is a promise to the person using the app, and for a while it
 * was a false one: thirteen cards, one of which did anything, and no way to
 * tell them apart until you clicked. `implemented` is what the cards read to
 * mark the difference, so it has to stay honest.
 */
describe('the tool list tells the truth about itself', () => {
  it('marks exactly the tools that do something', () => {
    const working = TOOLS.filter((tool) => tool.implemented).map((tool) => tool.id);
    // Edit, Organize, Export, Compare, OCR, Combine, Compress, AI and Page marks are Warraq's own (ADR-0008); five run on EmbedPDF (ADR-0007).
    expect(working).toEqual([
      'edit',
      'organize',
      'comment',
      'fillSign',
      'protect',
      'redact',
      'export',
      'compare',
      'ocr',
      'combine',
      'compress',
      'prepareForm',
      'ai',
      'pageMarks',
      'certificates',
    ]);
  });

  it('gives every working EmbedPDF tool real controls, named in both languages', () => {
    const warraqs = ['edit', 'organize', 'export', 'compare', 'ocr', 'combine', 'compress', 'ai', 'pageMarks', 'certificates'];
    for (const tool of TOOLS.filter((candidate) => !warraqs.includes(candidate.id) && candidate.implemented)) {
      expect(tool.actions?.length, `${tool.id} has controls`).toBeGreaterThan(0);
      for (const action of tool.actions ?? []) {
        // ids as the viewer registers them, "namespace:name" — listed at runtime
        expect(action.command, tool.id).toMatch(/^[a-z-]+:[a-z-]+$/);
        expect(en, action.labelKey).toHaveProperty(action.labelKey);
        expect(ar, action.labelKey).toHaveProperty(action.labelKey);
      }
    }
  });

  it('never offers controls on a tool it still calls Later', () => {
    for (const tool of TOOLS.filter((candidate) => !candidate.implemented)) {
      expect(tool.actions ?? [], tool.id).toHaveLength(0);
    }
  });

  it('names every tool in both languages', () => {
    for (const tool of TOOLS) {
      expect(en, `${tool.id} in English`).toHaveProperty(tool.labelKey);
      expect(ar, `${tool.id} in Arabic`).toHaveProperty(tool.labelKey);
    }
  });

  it('has the words a card needs to admit it is not ready', () => {
    for (const key of ['tool.later', 'tool.notYet', 'tool.comingLater']) {
      expect(en, key).toHaveProperty(key);
      expect(ar, key).toHaveProperty(key);
    }
  });
});
