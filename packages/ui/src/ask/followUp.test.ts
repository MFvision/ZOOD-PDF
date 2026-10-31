import { describe, expect, it } from 'vitest';
import {
  addressesIn,
  asksBack,
  historyMessages,
  isNo,
  isYes,
  linkIn,
  siteAsked,
  siteName,
  stillFresh,
} from './followUp';

describe('siteAsked', () => {
  it('opens the site the owner asked for, the last one when he corrected himself', () => {
    expect(siteAsked('Can you go to Amazon dot com? Amazon dot sa')).toBe('https://amazon.sa');
    expect(siteAsked('Can you go to Amazon.com? Amazon.sa')).toBe('https://amazon.sa');
    expect(siteAsked('open www.noon.com/saudi-en please')).toBe('https://www.noon.com/saudi-en');
    expect(siteAsked('take me to youtube')).toBe('https://youtube.com');
    expect(siteAsked('go to amazon')).toBe('https://amazon.sa');
  });

  it('understands Arabic', () => {
    expect(siteAsked('افتح موقع امازون')).toBe('https://amazon.sa');
    expect(siteAsked('ودني يوتيوب')).toBe('https://youtube.com');
    expect(siteAsked('افتح absher.sa')).toBe('https://absher.sa');
    expect(siteAsked('روح لـ نون دوت كوم')).toBe('https://noon.com');
  });

  it('leaves files, pages, settings and ZOOD things alone', () => {
    expect(siteAsked('open the file report.pdf')).toBeNull();
    expect(siteAsked('go to page 5')).toBeNull();
    expect(siteAsked('open settings')).toBeNull();
    expect(siteAsked('open google drive')).toBeNull();
    expect(siteAsked('open Safari.app')).toBeNull();
    expect(siteAsked('what is amazon.sa?')).toBeNull();
    expect(siteAsked('افتح الملف')).toBeNull();
    expect(siteAsked('compress this file')).toBeNull();
  });

  it('searches for a named site it does not know', () => {
    expect(siteAsked('open the Saudi Post website')).toBe(
      'https://www.google.com/search?q=saudi%20post',
    );
  });
});

describe('answering back', () => {
  it('hears yes and no', () => {
    for (const yes of [
      'yes',
      'Yes.',
      'yeah sure',
      'yes take me there',
      'ok',
      'please do',
      'نعم',
      'إيه',
      'ايه ودني',
      'تمام',
      'يلا',
      'zood, yes please',
    ])
      expect(isYes(yes), yes).toBe(true);
    for (const not of [
      'yes I want to compress the files in my downloads folder',
      'what is the weather',
      'no',
      'open settings',
    ])
      expect(isYes(not), not).toBe(false);
    for (const no of ['no', 'No thanks', 'not now', 'لا', 'لا شكرا', 'خلاص'])
      expect(isNo(no), no).toBe(true);
    expect(isNo('now compress it')).toBe(false);
  });

  it('finds the link an answer gives or names', () => {
    expect(linkIn('Amazon Saudi is at amazon.sa. Do you want me to take you there?')).toBe(
      'https://amazon.sa',
    );
    expect(linkIn('See https://www.noon.com/saudi-en/.')).toBe('https://www.noon.com/saudi-en/');
    expect(linkIn('Winter in Riyadh is cool and dry.')).toBeNull();
    expect(addressesIn('amazon dot com and noon dot com')).toEqual([
      'https://amazon.com',
      'https://noon.com',
    ]);
  });

  it('knows an answer that asks back, and forgets it after a few minutes', () => {
    expect(asksBack('Do you want me to take you there?')).toBe(true);
    expect(asksBack('تبيني أوديك له؟')).toBe(true);
    expect(asksBack('Opening amazon.sa.')).toBe(false);
    const turn = {
      words: 'what is amazon',
      say: 'A shop. Want to go there?',
      text: '',
      url: 'https://amazon.sa',
      at: 1000,
    };
    expect(stillFresh(turn, 2000)).toBe(true);
    expect(stillFresh(turn, 1000 + 5 * 60_000)).toBe(false);
    expect(historyMessages(turn, 2000)).toHaveLength(2);
    expect(historyMessages(turn, 1000 + 5 * 60_000)).toEqual([]);
    expect(siteName('https://www.amazon.sa/dp/1')).toBe('amazon.sa');
  });
});
