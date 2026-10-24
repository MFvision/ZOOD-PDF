import { describe, expect, it } from 'vitest';
import { readAnswer } from './voice';

describe('what the person says to a Sort window', () => {
  it('does all, in either language', () => {
    for (const said of ['do all', 'yes', 'كلها', 'نفذ الكل', 'تمام', 'okay go'])
      expect(readAnswer(said), said).toEqual({ kind: 'do', all: true, only: [], skip: [] });
  });

  it('does what is named, and leaves what is not wanted', () => {
    expect(readAnswer('merge them but don’t rename')).toEqual({ kind: 'do', all: false, only: ['merge'], skip: ['rename'] });
    expect(readAnswer("merge them but don't rename")).toEqual({ kind: 'do', all: false, only: ['merge'], skip: ['rename'] });
    expect(readAnswer('ادمجها ولا تغير الأسماء')).toEqual({ kind: 'do', all: false, only: ['merge'], skip: ['rename'] });
    expect(readAnswer('افصل الفواتير ورتبها في مجلدات')).toEqual({ kind: 'do', all: false, only: ['split', 'folders'], skip: [] });
    expect(readAnswer('just put them in folders')).toEqual({ kind: 'do', all: false, only: ['folders'], skip: [] });
  });

  it('does everything else when only told what not to do', () => {
    expect(readAnswer("don't merge")).toEqual({ kind: 'do', all: true, only: [], skip: ['merge'] });
    expect(readAnswer('كله بس لا تدمج')).toEqual({ kind: 'do', all: true, only: [], skip: ['merge'] });
  });

  it('undoes and closes', () => {
    expect(readAnswer('undo')).toEqual({ kind: 'undo' });
    expect(readAnswer('رجعها مثل ما كانت')).toEqual({ kind: 'undo' });
    expect(readAnswer('cancel')).toEqual({ kind: 'close' });
    expect(readAnswer('لا خلاص')).toEqual({ kind: 'close' });
  });

  it('says it did not understand rather than guess', () => {
    expect(readAnswer('what is the weather')).toEqual({ kind: 'unknown' });
    expect(readAnswer('')).toEqual({ kind: 'unknown' });
  });
});
