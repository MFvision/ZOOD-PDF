// The welcome tour room: the app's tour window, drawn, walks through its eight
// chapters as you scroll. Each one ticks off in the side list, the progress
// bar fills, Next is pressed and the next chapter slides in with its own
// small picture. A drawing of the app's tour (packages/ui/src/tour), not a
// recording; the chapter names and titles are the app's own.
import { clamp, ease, setter, span, spring, stepped } from './motion.js';

const WORDS = {
  title: { ar: 'جولة تعريفية', en: 'Welcome tour' },
  minutes: { ar: 'دقيقتان تقريبًا', en: 'About two minutes' },
  of: { ar: (n) => `الفصل ${n} من 8`, en: (n) => `Chapter ${n} of 8` },
  next: { ar: 'التالي', en: 'Next' },
  help: {
    ar: 'افتح هذه الجولة متى شئت من مساعدة › جولة تعريفية.',
    en: 'Open this tour any time from Help › Welcome tour.',
  },
};

// The chapters: the side list's name, the page's title, and its picture.
const CHAPTERS = [
  {
    pic: 'welcome',
    name: { ar: 'مرحبًا', en: 'Welcome' },
    head: { ar: 'أهلًا بك في محرر زود PDF', en: 'Welcome to ZOOD PDF' },
  },
  {
    pic: 'look',
    name: { ar: 'مظهرك', en: 'Your look' },
    head: { ar: 'اجعله على ذوقك', en: 'Make it yours' },
  },
  {
    pic: 'film',
    name: { ar: 'الفيلم', en: 'The film' },
    head: { ar: 'شاهده في ٣٠ ثانية', en: 'See it in 30 seconds' },
  },
  {
    pic: 'basics',
    name: { ar: 'افتح وحرّر', en: 'Open and edit' },
    head: { ar: 'افتح، حرّر، احفظ', en: 'Open, edit, save' },
  },
  {
    pic: 'ring',
    name: { ar: 'الدائرة والزر الأيمن', en: 'Ring and right-click' },
    head: { ar: 'أدوات سريعة دون فتح التطبيق', en: 'Quick tools, without opening the app' },
  },
  {
    pic: 'remote',
    name: { ar: 'التحكم بالجوال', en: 'Phone remote' },
    head: { ar: 'جوالك جهاز تحكم', en: 'Your phone as a remote' },
  },
  {
    pic: 'ai',
    name: { ar: 'الذكاء والقراءة', en: 'AI and read aloud' },
    head: { ar: 'اسأل المستند، أو استمع إليه', en: 'Ask the document, or hear it' },
  },
  {
    pic: 'done',
    name: { ar: 'جاهز', en: 'All set' },
    head: { ar: 'كل شيء جاهز', en: "You're all set" },
  },
];

const check =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const play =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

// Each chapter's small picture, drawn plainly.
const PICS = {
  welcome: '<span class="tr-mark"></span>',
  look: '<span class="tr-looks"><i></i><i></i><i class="on"></i><i></i><i></i></span>',
  film: `<span class="tr-film"><b>${play}</b></span>`,
  basics: '<span class="tr-page"><i></i><i class="on"></i><i></i><i></i></span>',
  ring: '<span class="tr-ring"><i></i></span>',
  remote: '<span class="tr-phone"><i></i></span><span class="tr-qr"></span>',
  ai: '<span class="tr-lines"><i></i><i></i><i></i></span>',
  done: `<span class="tr-done">${check}</span>`,
};

export function tourScene(t, escape) {
  const e = (w) => escape(t(w));
  const side = CHAPTERS.map(
    (c, k) => `<li style="--k:${k}"><span class="tr-tick">${check}</span>${e(c.name)}</li>`,
  ).join('');
  const pages = CHAPTERS.map(
    (c, k) =>
      `<div class="tr-pg" style="--k:${k}"><small>${escape(t(WORDS.of)(k + 1))}</small><b>${e(c.head)}</b><div class="tr-pic tr-p-${c.pic}">${PICS[c.pic]}</div></div>`,
  ).join('');
  return `<div class="tr glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="tr-win">
      <p class="tr-bar">${e(WORDS.title)}<i></i></p>
      <div class="tr-body">
        <div class="tr-side"><p class="tr-min"><span class="tr-mark"></span>${e(WORDS.minutes)}</p><ol>${side}</ol><small>${e(WORDS.help)}</small></div>
        <div class="tr-main"><span class="tr-prog"></span>${pages}<span class="tr-next">${e(WORDS.next)} <b>›</b></span></div>
      </div>
    </div>
  </div>`;
}

export function tourFrame(el, p, reduced) {
  const scene = el.querySelector('.tr');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.06, 0.18, 0.3, 0.42, 0.54, 0.66, 0.78, 0.94]);
  const set = (scene.__set ??= setter(scene));
  set('--in', ease(span(p, 0, 0.08)));
  set('--drift', clamp(p));
  // Eight chapters across the room; each turns over at its end.
  const at = clamp((p - 0.06) / 0.11, 0, 7.999);
  const now = Math.floor(at);
  const turn = at - now;
  set('--prog', (now + 1) / 8);
  scene.toggleAttribute('data-last', now === 7);
  // Next is pressed just before the page turns.
  set('--press', now < 7 ? span(turn, 0.82, 0.9) * (1 - span(turn, 0.9, 0.98)) : 0);
  scene.querySelectorAll('.tr-side li').forEach((li, k) => {
    li.classList.toggle('on', k === now);
    li.classList.toggle('done', k < now);
  });
  // A page leaves just as the next one comes in, so one is always there.
  scene.querySelectorAll('.tr-pg').forEach((pg, k) => {
    const come = k === 0 ? 1 : clamp((at - k + 0.06) * 8);
    const go = k === 7 ? 0 : clamp((at - k - 0.94) * 16);
    const shown = reduced ? +(k === now) : spring(come) * (1 - go);
    pg.style.setProperty('--s', shown.toFixed(3));
  });
}
