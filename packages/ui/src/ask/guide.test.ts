import { describe, expect, it } from 'vitest';
import {
  explainPrompt,
  MAX_PARTS,
  near,
  nextStepPrompt,
  partsGrammar,
  readingTime,
  readNextStep,
  readParts,
  risky,
  stepGrammar,
} from './guide';

describe('Ask ZOOD guiding on the screen', () => {
  it('reads the next step, or that the goal is reached', () => {
    expect(readNextStep('{"done":false,"say":"Click Save","x":1200,"y":-5}')).toEqual({
      done: false,
      say: 'Click Save',
      step: { say: 'Click Save', x: 1000, y: 0 },
    });
    expect(readNextStep('{"done":true,"say":"All done.","x":0,"y":0}')).toEqual({
      done: true,
      say: 'All done.',
      step: null,
    });
    // A step needs words and a place.
    expect(readNextStep('{"done":false,"say":"","x":10,"y":10}')).toBeNull();
    expect(readNextStep('{"done":false,"say":"Click","x":"left","y":10}')).toBeNull();
    expect(readNextStep('not json')).toBeNull();
    expect(readNextStep('[1,2]')).toBeNull();
  });

  it('keeps an explanation to the parts that have a place, at most a few', () => {
    const parts = Array.from({ length: 9 }, (_, index) => ({ say: `Part ${index}`, x: index * 100, y: 50 }));
    const read = readParts(JSON.stringify({ say: 'The print window.', parts: [{ say: 'No place' }, ...parts] }));
    expect(read?.say).toBe('The print window.');
    expect(read?.parts).toHaveLength(MAX_PARTS);
    expect(read?.parts[0]).toEqual({ say: 'Part 0', x: 0, y: 50 });
    expect(readParts('{"say":"","parts":[]}')).toBeNull();
  });

  it('stops before what sends, deletes, pays or signs, in English and Arabic', () => {
    for (const text of ['Click Send', 'Delete the file', 'Pay now', 'Sign the contract', 'اضغط إرسال', 'احذف الصفحة', 'ادفع الفاتورة', 'وقّع هنا'])
      expect(risky(text), text).toBe(true);
    for (const text of ['Click Save', 'Open Settings', 'Sign in', 'افتح الإعدادات', 'اختر الوضع الداكن'])
      expect(risky(text), text).toBe(false);
  });

  it('counts a click near the step as reaching it', () => {
    expect(near({ x: 0.5, y: 0.5 }, { x: 0.53, y: 0.52 })).toBe(true);
    expect(near({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 })).toBe(false);
    expect(near({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 })).toBe(true);
    expect(near({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.75 })).toBe(false);
  });

  it('tells the model the goal, the steps taken and the language', () => {
    const prompt = nextStepPrompt('turn on dark mode', ['Click Settings'], 'do', 'ar');
    expect(prompt).toContain('turn on dark mode');
    expect(prompt).toContain('1. Click Settings');
    expect(prompt).toContain('Arabic');
    expect(explainPrompt('explain this', 'en')).toContain('English');
    expect(stepGrammar()).toContain('done');
    expect(partsGrammar()).toContain('parts');
  });

  it('leaves a part up long enough to read', () => {
    expect(readingTime('Hi')).toBe(2600);
    expect(readingTime('x'.repeat(500))).toBe(7000);
  });
});
