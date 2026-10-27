import { describe, expect, it } from 'vitest';
import { ARTICLES } from '../../support/articles';
import { helpFor, helpText, isHowTo } from './help';

describe('how-to questions in the general chat', () => {
  it('are told from other messages, in Arabic and English', () => {
    expect(isHowTo('How do I sign a PDF?')).toBe(true);
    expect(isHowTo('كيف أوقع ملف PDF؟')).toBe(true);
    expect(isHowTo('وين أضغط الملف؟')).toBe(true);
    expect(isHowTo('Write an email to Sara about Thursday')).toBe(false);
    expect(isHowTo('اكتب لي رسالة شكر')).toBe(false);
  });

  it('are answered by the guide that fits', () => {
    expect(helpFor('How do I sign a PDF?', 'en', true)?.id).toBe('sign');
    expect(helpFor('How do I compress a file?', 'en', true)?.id).toBe('compress');
    expect(helpFor('كيف أدمج ملفات PDF؟', 'ar', true)?.id).toBe('combine');
  });

  it('are left to the model when no guide answers them', () => {
    expect(helpFor('How do I cook rice?', 'en', true)).toBeNull();
    expect(helpFor('Summarise the news for me', 'en', true)).toBeNull();
  });

  it('never offer a desktop-only guide in the browser', () => {
    const found = helpFor('How do I control it from my phone?', 'en', false);
    expect(found?.desktopOnly ?? false).toBe(false);
  });

  it('put the guide in words to copy or read aloud', () => {
    const sign = ARTICLES.find((one) => one.id === 'sign')!;
    const text = helpText(sign, 'en');
    expect(text.startsWith(sign.title.en)).toBe(true);
    expect(text).toContain(`1. ${sign.steps[0]!.en}`);
  });
});

describe('the general chat chips', () => {
  it('still go to the model', () => {
    expect(helpFor('What can you help me with, and what can I ask you to do in ZOOD PDF?', 'en', true)).toBeNull();
    expect(helpFor('بماذا تستطيع مساعدتي، وما الذي أستطيع أن أطلبه منك في ZOOD PDF؟', 'ar', true)).toBeNull();
  });
});
