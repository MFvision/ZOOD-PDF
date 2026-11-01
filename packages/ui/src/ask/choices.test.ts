import { describe, expect, it } from 'vitest';
import { pickByWords, sayChoices } from './choices';

describe('sayChoices', () => {
  it('reads two choices as a question', () => {
    expect(sayChoices('Which one did you mean?', ['Compress', 'Organise pages'], 'en')).toBe('Which one did you mean: Compress, or Organise pages?');
    expect(sayChoices('أيّهما تقصد؟', ['الضغط', 'تنظيم الصفحات'], 'ar')).toBe('أيّهما تقصد: الضغط، أم تنظيم الصفحات؟');
  });

  it('numbers more choices and says the way out last', () => {
    expect(sayChoices('Did you mean one of these?', ['Protect', 'Watermark', 'Page numbers'], 'en', 'Something else')).toBe(
      'Did you mean one of these? First: Protect. Second: Watermark. Third: Page numbers. Or say: Something else.',
    );
    expect(sayChoices('هل تقصد واحدًا من هذه؟', ['الحماية', 'العلامة المائية'], 'ar', 'شيء آخر')).toBe(
      'هل تقصد واحدًا من هذه؟ الأول: الحماية. الثاني: العلامة المائية. أو قل: شيء آخر.',
    );
  });

  it('says the question alone when there is nothing to choose', () => {
    expect(sayChoices('Which one did you mean?', [], 'en')).toBe('Which one did you mean?');
  });
});

describe('pickByWords', () => {
  const names = ['Protect', 'Compress', 'Page numbers'];

  it('takes a place, in English or Arabic', () => {
    expect(pickByWords('the second one', names)).toBe(1);
    expect(pickByWords('Second.', names)).toBe(1);
    expect(pickByWords('number 3 please', names)).toBe(2);
    expect(pickByWords('الأول', names)).toBe(0);
    expect(pickByWords('ابي الثاني', names)).toBe(1);
    expect(pickByWords('٣', names)).toBe(2);
    expect(pickByWords('the last one', names)).toBe(2);
    expect(pickByWords('الأخير', names)).toBe(2);
  });

  it('takes a choice by its name', () => {
    expect(pickByWords('compress', names)).toBe(1);
    expect(pickByWords('page numbers please', names)).toBe(2);
    expect(pickByWords('الضغط', ['الحماية', 'الضغط'])).toBe(1);
  });

  it('leaves a new request alone', () => {
    expect(pickByWords('open the first file in my downloads folder and compress it', names)).toBeNull();
    expect(pickByWords('fourth', names)).toBeNull();
    expect(pickByWords('hello', names)).toBeNull();
    expect(pickByWords('', names)).toBeNull();
  });
});

describe('pickByWords and a "don’t"', () => {
  const names = ['Compress', 'Convert to Word', 'ضغط'];
  it('never picks a choice the words turn down', () => {
    for (const words of ['not the second', "don't compress", 'لا تسوي ضغط', 'لا الثاني']) expect(pickByWords(words, names), words).toBeNull();
  });
  it('still picks a choice said plainly', () => {
    expect(pickByWords('the second', names)).toBe(1);
    expect(pickByWords('compress', names)).toBe(0);
  });
});
