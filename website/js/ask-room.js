// The Ask ZOOD room: an email waits for a reply, the right Ctrl key is tapped
// twice, the island drops in from the top of the screen and reads the window,
// and the reply writes itself into the box, in the person's own style, with
// nothing sent. Then "Coming up" slides in: dates found in the Library. A
// drawing of the desktop app's island (packages/ui/src/ask), not a recording;
// its words are the app's own.
import { clamp, ease, setter, span, spring, stepped } from './motion.js';

const WORDS = {
  app: { ar: 'البريد', en: 'Email' },
  from: { ar: 'علي', en: 'Ali' },
  message: { ar: 'هل يمكنك تأكيد موعد الدفع؟', en: 'Could you confirm when the payment is due?' },
  reply: {
    ar: 'أهلًا علي، سأؤكد لك موعد الدفع يوم الخميس. مع التحية، سارة',
    en: "Hi Ali, I'll confirm the payment date on Thursday. Best regards, Sara",
  },
  replyTo: { ar: 'ردّ', en: 'Reply' },
  tap: { ar: 'Ctrl الأيمن، مرتين', en: 'Right Ctrl, twice' },
  reading: { ar: 'أقرأ النافذة…', en: 'Reading the window…' },
  drafting: { ar: 'أكتب ردّك…', en: 'Writing your reply…' },
  placed: {
    ar: 'المسودة في مكانها. اقرأها وعدّلها ثم أرسلها.',
    en: 'Your draft is in. Read it, change it, send it.',
  },
  hint: { ar: 'لم يُرسل شيء. Ctrl+Z يزيلها.', en: 'Nothing was sent. Ctrl+Z takes it back out.' },
  again: { ar: 'اكتبه من جديد', en: 'Write it again' },
  copy: { ar: 'نسخ', en: 'Copy' },
  today: { ar: 'مواعيد قريبة في مستنداتك', en: 'Coming up in your documents' },
  dates: {
    ar: [
      ['تجديد عقد الإيجار', 'عقد الإيجار، ص 2', 'بعد 3 أيام'],
      ['استحقاق الفاتورة 1047', 'الفواتير 2026، ص 3', 'بعد 9 أيام'],
    ],
    en: [
      ['Lease renewal', 'Lease, p. 2', 'In 3 days'],
      ['Invoice 1047 due', 'Invoices 2026, p. 3', 'In 9 days'],
    ],
  },
};

const icon = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  pen: icon('<path d="M4 20l4-1 11-11-3-3L5 16z"/>'),
  again: icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  copy: icon(
    '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  ),
  cal: icon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
};

export function askScene(t, escape) {
  const e = (w) => escape(t(w));
  // The reply arrives a word at a time: Arabic is never cut inside a word.
  const words = t(WORDS.reply)
    .split(' ')
    .map((w) => `<i>${escape(w)} </i>`)
    .join('');
  const dates = t(WORDS.dates)
    .map(
      ([what, where, when], k) =>
        `<li style="--k:${k}"><b>${escape(what)}</b><small>${escape(where)}</small><em>${escape(when)}</em></li>`,
    )
    .join('');
  return `<div class="ask glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="ask-win">
      <p class="ask-wbar">${e(WORDS.app)}</p>
      <div class="ask-msg"><span class="ask-av">${e(WORDS.from).slice(0, 1)}</span><div><b>${e(WORDS.from)}</b><p>${e(WORDS.message)}</p></div></div>
      <div class="ask-reply"><small>${e(WORDS.replyTo)}</small><p class="ask-typed">${words}<span class="ai-caret"></span></p></div>
    </div>
    <div class="ask-key glass"><kbd>Ctrl</kbd><span>${e(WORDS.tap)}</span></div>
    <div class="ask-island">
      <div class="ask-state ask-s-read"><span class="ask-dot ask-spin"></span><b>${e(WORDS.reading)}</b></div>
      <div class="ask-state ask-s-write"><span class="ask-dot">${ICONS.pen}</span><b>${e(WORDS.drafting)}</b></div>
      <div class="ask-state ask-s-done"><span class="ask-dot">${ICONS.pen}</span><b>${e(WORDS.placed)}</b>
        <small>${e(WORDS.hint)}</small>
        <span class="ask-btns"><span>${ICONS.again}${e(WORDS.again)}</span><span>${ICONS.copy}${e(WORDS.copy)}</span></span></div>
    </div>
    <div class="ask-today glass"><p>${ICONS.cal}${e(WORDS.today)}</p><ul>${dates}</ul></div>
  </div>`;
}

export function askFrame(el, p, reduced) {
  const scene = el.querySelector('.ask');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.06, 0.62, 0.9]);
  const set = (scene.__set ??= setter(scene));

  set('--in', ease(span(p, 0, 0.08)));
  // Two quick taps on the key.
  const tap = (a) => span(p, a, a + 0.02) * (1 - span(p, a + 0.02, a + 0.04));
  set('--key', spring(span(p, 0.05, 0.12)) * (1 - ease(span(p, 0.3, 0.36))));
  set('--tap', Math.max(tap(0.13), tap(0.18)));
  // The island drops in, reads, writes, then says where the draft is.
  set('--isl', spring(span(p, 0.22, 0.3)));
  const state = p < 0.34 ? 'read' : p < 0.56 ? 'write' : 'done';
  scene.dataset.state = state;
  set('--done', spring(span(p, 0.56, 0.64)));
  // The reply, a word at a time, with light at the caret while it writes.
  const words = scene.querySelectorAll('.ask-typed i');
  const n = Math.round(words.length * span(p, 0.34, 0.56));
  words.forEach((w, k) => w.classList.toggle('on', k < n));
  set('--write', state === 'write' ? 1 : 0);
  // "Coming up": dates found in the Library.
  set('--today', ease(span(p, 0.68, 0.8)));
  scene.querySelectorAll('.ask-today li').forEach((li, k) => {
    li.style.setProperty('--d', spring(span(p, 0.74 + k * 0.05, 0.84 + k * 0.05)).toFixed(3));
  });
  set('--drift', clamp(p));
}
