import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/messages';
import type { Lang, TKey, TParams } from '../i18n/messages';
import { comparePages } from './comparison';
import { EXACT } from './normalize';
import { comparisonReport, escapeHtml, isolate } from './report';

const SENTENCE = 'هذه جملة جديدة كتبها اختبار المقارنة';
const TITLE = 'كلمة رئيس مجموعة البنك الدولي';

function report(older: string[], newer: string[], lang: Lang = 'ar', options = EXACT) {
  const t = (key: TKey, params?: TParams) => translate(lang, key, params);
  return comparisonReport({
    comparison: comparePages(older, newer, options),
    options,
    // As the panel names them.
    older: t('compare.revisionOf', { n: 1, name: isolate('report.pdf') }),
    newer: t('compare.openNow', { name: isolate('report.pdf') }),
    date: '18 سبتمبر 2026',
    lang,
    t,
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
  });

  it('keeps each version name in the report’s direction, the file name isolated inside it', () => {
    // A Latin file name first no longer turns an Arabic sentence left to right.
    expect(report([TITLE], [SENTENCE], 'ar')).toContain('<dd>⁨report.pdf⁩ (المفتوح الآن)</dd>');
    expect(report([TITLE], [SENTENCE], 'en')).toContain('<dd>Revision 1 of ⁨report.pdf⁩</dd>');
    expect(isolate('تقرير.pdf')).toBe('⁨تقرير.pdf⁩');
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
    expect(html).toContain('<dd>&lt;i&gt;a&lt;/i&gt;.pdf</dd>');
    expect(html).toContain('<dd>b &amp; &quot;c&quot;.pdf</dd>');
    expect(html).toContain('&lt;now&gt;');
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('shows the pages that look different as pictures, and takes nothing else for one', () => {
    const t = (key: TKey, params?: TParams) => translate('en', key, params);
    const html = comparisonReport({
      comparison: comparePages([TITLE], [TITLE], EXACT),
      options: EXACT,
      older: 'a.pdf',
      newer: 'b.pdf',
      date: '18 September 2026',
      lang: 'en',
      t,
      looks: [
        { page: 2, picture: 'data:image/png;base64,iVBORw0KGgo=' },
        { page: 3, picture: 'https://example.com/x.png' },
        { page: 4, picture: 'data:image/png;base64,AAA="><script>alert(1)</script>' },
      ],
    });
    expect(html).toContain('Pages that look different');
    expect(html).toContain(
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Page 2, with what looks different outlined">',
    );
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).not.toMatch(/https?:|<script/i);
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
