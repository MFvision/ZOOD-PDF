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
    expect(working).toEqual(['edit']);
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
