// The library room: a shelf of files stands up, a word is typed into the
// search bar, the files that hold it light up, and the first one slides off
// the shelf and turns to show the line it was found on, its page and its tag.
// A drawing of the Library, not a recording: the shelf is made up.
import { clamp, ease, setter, span, spring, stepped } from './motion.js';

const WORDS = {
  query: { ar: 'فاتورة', en: 'invoice' },
  hint: { ar: 'ابحث في كل ملفاتك', en: 'Search all your files' },
  found: { ar: '3 ملفات', en: '3 files' },
  page: { ar: 'ص 3', en: 'p. 3' },
  tag: { ar: 'فواتير', en: 'Invoices' },
  line: {
    ar: ['', 'فاتورة', ' رقم 1047 لشركة وهمية، تُدفع خلال ثلاثين يومًا.'],
    en: ['', 'Invoice', ' no. 1047 for a made-up company, due in thirty days.'],
  },
  kinds: { pdf: 'PDF', scan: { ar: 'ممسوح', en: 'Scan' }, pic: { ar: 'صورة', en: 'Picture' } },
};

// The shelf, left to right as drawn: a label, a kind, a height (0-1), a colour
// and whether the search finds it. The first hit is the one that comes out.
const SHELF = [
  { ar: 'عقد الإيجار', en: 'Lease', kind: 'pdf', h: 0.86, c: 'navy' },
  { ar: 'تقرير الربع', en: 'Quarterly report', kind: 'pdf', h: 0.78, c: 'beige' },
  { ar: 'إيصال ممسوح', en: 'Scanned receipt', kind: 'scan', h: 0.7, c: 'paper', hit: 2 },
  { ar: 'الفواتير 2026', en: 'Invoices 2026', kind: 'pdf', h: 0.96, c: 'bronze', hit: 1 },
  { ar: 'محضر الاجتماع', en: 'Meeting notes', kind: 'pdf', h: 0.8, c: 'blue' },
  { ar: 'صورة فاتورة', en: 'Invoice photo', kind: 'pic', h: 0.66, c: 'copper', hit: 3 },
  { ar: 'دليل الموظف', en: 'Staff handbook', kind: 'pdf', h: 0.92, c: 'navy' },
  { ar: 'شهادة', en: 'Certificate', kind: 'pdf', h: 0.72, c: 'beige' },
  { ar: 'كتالوج', en: 'Catalogue', kind: 'pdf', h: 0.84, c: 'blue' },
];
const TOP = SHELF.findIndex((s) => s.hit === 1);

const search =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>';
const check =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

export function libraryScene(t, escape) {
  const spines = SHELF.map(
    (s, k) =>
      `<div class="lib-spine c-${s.c}${s.hit ? ' hit' : ''}" style="--k:${k};--h:${s.h}"><span class="lib-label">${escape(t(s))}</span><span class="lib-kind">${escape(t(WORDS.kinds[s.kind]))}</span></div>`,
  ).join('');
  const [before, word, after] = t(WORDS.line);
  return `<div class="lib glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="lib-search glass"><span class="lib-icon">${search}</span><span class="lib-typed" data-text="${escape(t(WORDS.query))}"></span><span class="lib-hint">${escape(t(WORDS.hint))}</span><span class="ai-caret"></span><span class="lib-count">${escape(t(WORDS.found))}</span></div>
    <div class="lib-shelf"><div class="lib-row">${spines}</div><div class="lib-plank"></div></div>
    <div class="lib-cover glass" style="--from:${TOP}">
      <div class="lib-cover-head"><span class="lib-cover-name">${escape(t(SHELF[TOP]))}</span><span class="ai-pg">${escape(t(WORDS.page))}</span></div>
      <div class="lib-bars"><i></i><i></i><i></i></div>
      <p class="lib-line">${escape(before)}<mark>${escape(word)}</mark>${escape(after)}</p>
      <div class="lib-bars"><i></i><i></i></div>
      <span class="lib-tag"><b>${check}</b>${escape(t(WORDS.tag))}</span>
    </div>
  </div>`;
}

export function libraryFrame(el, p, reduced) {
  const scene = el.querySelector('.lib');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.06, 0.4, 0.86]);
  const set = (scene.__set ??= setter(scene));

  set('--in', ease(span(p, 0, 0.1)));
  // The files stand up on the shelf one after another, each landing with a bounce.
  scene.querySelectorAll('.lib-spine').forEach((spine, k) => {
    spine.style.setProperty('--up', spring(span(p, 0.02 + k * 0.012, 0.14 + k * 0.012)).toFixed(3));
  });
  const typed = scene.querySelector('.lib-typed');
  const text = typed.dataset.text;
  const n = Math.round(text.length * span(p, 0.14, 0.28));
  const shown = [...text].slice(0, n).join('');
  if (typed.textContent !== shown) typed.textContent = shown;
  scene.classList.toggle('lib-has-text', n > 0);
  // Matches glow, the rest step back; the count pops in.
  set('--found', ease(span(p, 0.3, 0.4)));
  set('--count', spring(span(p, 0.34, 0.44)));
  // The first match leaves the shelf and turns to face you.
  set('--pull', ease(span(p, 0.44, 0.56)));
  set('--turn', ease(span(p, 0.52, 0.7)));
  set('--mark', ease(span(p, 0.68, 0.76)));
  set('--tag', spring(span(p, 0.74, 0.84)));
  // The whole room takes on the tag's colour.
  (el.__set ??= setter(el))('--tint', ease(span(p, 0.72, 0.9)));
  set('--drift', clamp(p));
}
