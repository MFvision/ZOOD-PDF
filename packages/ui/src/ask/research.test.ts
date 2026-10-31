import { describe, expect, it } from 'vitest';
import { answerSheet, markdownTable, researchAsked, researchMessages, researchQuery, wantsTable } from './research';

describe('Ask ZOOD on the web', () => {
  it('knows a request for the web from one for the Library or the screen', () => {
    for (const asked of [
      'find three Mac setup accessories under $100 and add their prices and links to a sheet',
      'search the internet for the best USB-C hubs',
      'look up Hostinger email pricing online',
      'what is the weather in Riyadh today',
      'google flights from Riyadh to Dubai',
      'دور لي في النت عن أفضل لابتوب للمحاسبين',
      'ابحث في الإنترنت عن أسعار الطابعات',
      'اقترح لي ثلاث سماعات أقل من 300 ريال',
      'وش الأخبار اليوم',
    ]) {
      expect(researchAsked(asked), asked).toBe(true);
    }
    for (const asked of [
      'find the rent contract',
      'search my files for the invoice from Ahmed',
      'how do I set up a company hub for our team?',
      'what is the weather like in winter?',
      'compress these files',
      'دور لي عقد الإيجار',
      'make me a presentation about our sales',
      'summarize this email',
      'find the invoice under 100 riyals in my files',
    ]) {
      expect(researchAsked(asked), asked).toBe(false);
    }
  });

  it('searches for the thing, not the request around it', () => {
    expect(researchQuery('search the internet for the best USB-C hubs')).toBe('the best USB-C hubs');
    expect(researchQuery('Please look up Hostinger email pricing online')).toBe('Hostinger email pricing');
    expect(researchQuery('find three Mac setup accessories under $100 and add their prices and links to a sheet')).toBe(
      'three Mac setup accessories under $100',
    );
    expect(researchQuery('دور لي في النت عن أفضل لابتوب للمحاسبين')).toBe('أفضل لابتوب للمحاسبين');
    expect(researchQuery('ابحث في الإنترنت عن أسعار الطابعات وحطها في جدول')).toBe('أسعار الطابعات');
    expect(researchQuery('weather in Riyadh today')).toBe('weather in Riyadh today');
  });

  it('answers things to compare or buy as a table', () => {
    expect(wantsTable('find three accessories under $100')).toBe(true);
    expect(wantsTable('compare Hostinger and GoDaddy')).toBe(true);
    expect(wantsTable('ابحث عن أسعار الطابعات')).toBe(true);
    expect(wantsTable('what is the weather in Riyadh today')).toBe(false);
  });

  it('gives the model the pages read and the other results, within the room it has', () => {
    const hits = [
      { title: 'Hubs', url: 'https://a.example/hubs', snippet: 'a list of hubs' },
      { title: 'Docks', url: 'https://b.example/docks', snippet: 'docks compared' },
    ];
    const pages = [{ url: 'https://a.example/hubs', title: 'Best hubs', text: 'x'.repeat(5000) }, null];
    const [system, user] = researchMessages('find hubs under $100', hits, pages, 'en', 2000, '2026-10-31');
    expect(system!.content).toContain('Markdown table');
    expect(system!.content).toContain('2026-10-31');
    expect(system!.content).toContain('Never invent a price');
    expect(user!.content).toContain('[1] Best hubs\nhttps://a.example/hubs');
    expect(user!.content).toContain('[2] Docks\nhttps://b.example/docks\ndocks compared');
    expect(user!.content.length).toBeLessThan(2200);
    const [arabic] = researchMessages('وش الأخبار اليوم', hits, pages, 'ar', 2000, '2026-10-31');
    expect(arabic!.content).toContain('Write in Arabic');
    expect(arabic!.content).toContain('Sources:');
  });

  it('keeps a table answer as a sheet with links, and lines as rows when there is none', () => {
    const answer = [
      'Here are three picks.',
      '',
      '| Item | Price | Link |',
      '|---|---:|---|',
      '| **Anker 7-in-1 hub** | $35.99 | https://a.example/anker |',
      '| Stand | not shown | [shop](https://b.example/stand) |',
      '',
      'Prices may have changed.',
    ].join('\n');
    expect(markdownTable(answer)).toEqual([
      ['Item', 'Price', 'Link'],
      ['**Anker 7-in-1 hub**', '$35.99', 'https://a.example/anker'],
      ['Stand', 'not shown', '[shop](https://b.example/stand)'],
    ]);
    const sheet = answerSheet('Hubs under $100', answer);
    expect(sheet.rtl).toBe(false);
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows[0]![0]).toMatchObject({ value: { kind: 'text', text: 'Item' }, fill: '1F3A5F' });
    expect(sheet.rows[1]![0]).toEqual({ value: { kind: 'text', text: 'Anker 7-in-1 hub' } });
    expect(sheet.rows[1]![1]!.value.kind).toBe('number');
    expect(sheet.rows[1]![2]).toEqual({ value: { kind: 'text', text: 'https://a.example/anker' }, link: 'https://a.example/anker' });
    expect(sheet.rows[2]![2]!.link).toBe('https://b.example/stand');
    const lines = answerSheet('الطقس', 'الجو اليوم معتدل\nالمصادر: [1]');
    expect(lines.rtl).toBe(true);
    expect(lines.rows).toHaveLength(2);
  });
});
