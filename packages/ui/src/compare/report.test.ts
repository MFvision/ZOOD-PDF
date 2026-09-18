import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/messages';
import type { Lang, TKey, TParams } from '../i18n/messages';
import { comparePages } from './comparison';
import { EXACT } from './normalize';
import { comparisonReport, escapeHtml } from './report';

const SENTENCE = 'هذه جملة جديدة كتبها اختبار المقارنة';
const TITLE = 'كلمة رئيس مجموعة البنك الدولي';

function report(older: string[], newer: string[], lang: Lang = 'ar', options = EXACT) {
  return comparisonReport({
    comparison: comparePages(older, newer, options),
    options,
    older: 'تقرير.pdf (المراجعة 1)',
    newer: 'تقرير.pdf',
    date: '18 سبتمبر 2026',
    lang,
    t: (key: TKey, params?: TParams) => translate(lang, key, params),
  });
}

describe('the comparison report', () => {
  it('is a standalone UTF-8 page: no script, nothing fetched', () => {
    const html = report([TITLE], [SENTENCE]);
    expect(html.startsWith('<!doctype html>\n')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|@import|url\(/i);
    expect(html).not.toMatch(/\s(src|href|action)=/i);
    expect(html).not.toMatch(/https?:/i);
  });

  it('is written right to left in Arabic and left to right in English', () => {
    expect(report([TITLE], [SENTENCE], 'ar')).toContain('<html lang="ar" dir="rtl">');
    expect(report([TITLE], [SENTENCE], 'en')).toContain('<html lang="en" dir="ltr">');
  });

  it('marks what was removed and added, each passage finding its own direction', () => {
    const html = report([`${TITLE} وبعد`], [`${SENTENCE} وبعد`], 'en');
    expect(html).toContain(
      `<p dir="auto"><del><span class="sr-only" dir="ltr">removed: </span>${TITLE}<span class="sr-only" dir="ltr"> end of removed text</span></del>` +
        ` <ins><span class="sr-only" dir="ltr">added: </span>${SENTENCE}<span class="sr-only" dir="ltr"> end of added text</span></ins> وبعد</p>`,
    );
    expect(html).toContain('<li>Pages changed: 1</li>');
    expect(html).toContain('<li>Words added: 6</li>');
    expect(html).toContain('<li>Words removed: 5</li>');
    expect(html).toContain('<h2>Page 1</h2>');
    // The version names can be in any script: each finds its own direction too.
    expect(html).toContain('<dd dir="auto">تقرير.pdf</dd>');
  });

  it('escapes every word of the documents and their names', () => {
    const html = comparisonReport({
      comparison: comparePages(['<b>old</b>'], [`<script>alert("x")</script> & 'q'`], EXACT),
      options: EXACT,
      older: '<i>a</i>.pdf',
      newer: 'b & "c".pdf',
      date: '<now>',
      lang: 'en',
      t: (key, params) => translate('en', key, params),
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>old');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect(html).toContain('&lt;b&gt;old&lt;/b&gt;');
    expect(html).toContain('<dd dir="auto">&lt;i&gt;a&lt;/i&gt;.pdf</dd>');
    expect(html).toContain('<dd dir="auto">b &amp; &quot;c&quot;.pdf</dd>');
    expect(html).toContain('&lt;now&gt;');
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('says so when nothing changed, and which options were on', () => {
    const plain = report([SENTENCE], [SENTENCE], 'ar', { ignoreMarks: true, unifyLetters: true });
    expect(plain).toContain(`<p>${translate('ar', 'compare.noChanges')}</p>`);
    expect(plain).toContain(translate('ar', 'compare.reportMarks'));
    expect(plain).toContain(translate('ar', 'compare.reportLetters'));
    expect(plain).not.toContain('<section>');
    expect(report([''], [' '], 'en')).toContain(`<p>${translate('en', 'compare.noText')}</p>`);
  });

  it('says when the page counts differ and which pages only one version has', () => {
    const html = report(['أ', 'ب'], ['أ', 'ب', 'ج'], 'en');
    expect(html).toContain('Pages in the older version: 2; in the newer: 3.');
    expect(html).toContain('This page is only in the newer version.');
  });
});
