// The Ask ZOOD room, in three acts. One tap of the right Ctrl key: the screen's
// edges glow with the voice, the island grows out of the notch, listens, and a
// quick ask is done with a one-line answer. Two taps in an email: the island
// reads the window and the reply writes itself into the box, with nothing
// sent. Then "Coming up" slides in: dates found in the Library. A drawing of
// the desktop app's island (packages/ui/src/ask), not a recording; its words
// are the app's own.
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
  once: { ar: 'Ctrl الأيمن، مرة', en: 'Right Ctrl, once' },
  tap: { ar: 'Ctrl الأيمن، مرتين', en: 'Right Ctrl, twice' },
  listening: { ar: 'أستمع…', en: 'Listening…' },
  said: { ar: 'صغّر حجم هذا الملف', en: 'Make this file smaller' },
  typeInstead: { ar: 'اكتب بدلًا من ذلك', en: 'Type instead' },
  did: { ar: 'تم. صار حجمه 1.8 ميغابايت.', en: 'Done. It is now 1.8 MB.' },
  file: { ar: 'تقرير الربع.pdf', en: 'Quarterly report.pdf' },
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
  check: icon('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  keys: icon('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  file: icon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
};
// The voice: five bars that follow it while the island listens.
const BARS = 5;

export function askScene(t, escape) {
  const e = (w) => escape(t(w));
  // Words arrive one at a time: Arabic is never cut inside a word.
  const byWord = (w) =>
    t(w)
      .split(' ')
      .map((x) => `<i>${escape(x)} </i>`)
      .join('');
  const dates = t(WORDS.dates)
    .map(
      ([what, where, when], k) =>
        `<li style="--k:${k}"><b>${escape(what)}</b><small>${escape(where)}</small><em>${escape(when)}</em></li>`,
    )
    .join('');
  const bars = Array.from({ length: BARS }, (_, k) => `<i style="--b:var(--b${k})"></i>`).join('');
  return `<div class="ask glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="ask-glow"><i></i><i></i></div>
    <div class="ask-file"><span class="ask-fic">${ICONS.file}<b>PDF</b></span><span><b>${e(WORDS.file)}</b><small><s dir="ltr">12.4 MB</s><em dir="ltr">1.8 MB</em></small></span></div>
    <div class="ask-win">
      <p class="ask-wbar">${e(WORDS.app)}</p>
      <div class="ask-msg"><span class="ask-av">${e(WORDS.from).slice(0, 1)}</span><div><b>${e(WORDS.from)}</b><p>${e(WORDS.message)}</p></div></div>
      <div class="ask-reply"><small>${e(WORDS.replyTo)}</small><p class="ask-typed ask-words">${byWord(WORDS.reply)}<span class="ai-caret"></span></p></div>
    </div>
    <div class="ask-key glass"><kbd>Ctrl</kbd><span class="ask-k1">${e(WORDS.once)}</span><span class="ask-k2">${e(WORDS.tap)}</span></div>
    <div class="ask-notch"></div>
    <div class="ask-island">
      <div class="ask-state ask-s-listen"><span class="ask-wave">${bars}</span><b>${e(WORDS.listening)}</b>
        <p class="ask-said ask-words">${byWord(WORDS.said)}</p>
        <span class="ask-btns"><span>${ICONS.keys}${e(WORDS.typeInstead)}</span></span></div>
      <div class="ask-state ask-s-did"><span class="ask-dot">${ICONS.check}</span><b>${e(WORDS.did)}</b></div>
      <div class="ask-state ask-s-read"><span class="ask-dot ask-spin"></span><b>${e(WORDS.reading)}</b></div>
      <div class="ask-state ask-s-write"><span class="ask-dot">${ICONS.pen}</span><b>${e(WORDS.drafting)}</b></div>
      <div class="ask-state ask-s-done"><span class="ask-dot">${ICONS.pen}</span><b>${e(WORDS.placed)}</b>
        <small>${e(WORDS.hint)}</small>
        <span class="ask-btns"><span>${ICONS.again}${e(WORDS.again)}</span><span>${ICONS.copy}${e(WORDS.copy)}</span></span></div>
    </div>
    <div class="ask-today glass"><p>${ICONS.cal}${e(WORDS.today)}</p><ul>${dates}</ul></div>
  </div>`;
}

// Shows the first n of a list of words.
function words(list, k) {
  const n = Math.round(list.length * k);
  list.forEach((w, j) => w.classList.toggle('on', j < n));
}

export function askFrame(el, p, reduced) {
  const scene = el.querySelector('.ask');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.04, 0.3, 0.76, 0.92]);
  const set = (scene.__set ??= setter(scene));
  const tap = (a) => span(p, a, a + 0.012) * (1 - span(p, a + 0.012, a + 0.025));

  set('--in', ease(span(p, 0, 0.05)));
  set('--drift', clamp(p));

  // Act one: one tap, talk, and a quick ask is done.
  const act2 = p >= 0.4;
  scene.dataset.act = act2 ? '2' : '1';
  set('--key', spring(span(p, 0.03, 0.08)) * (1 - ease(span(p, 0.84, 0.88))));
  set('--tap', act2 ? Math.max(tap(0.44), tap(0.47)) : tap(0.08));
  set('--file', ease(span(p, 0.03, 0.08)) * (1 - ease(span(p, 0.36, 0.41))));
  const glow = ease(span(p, 0.09, 0.12)) * (1 - ease(span(p, 0.23, 0.27)));
  set('--glow', glow);
  // The voice: a few sines, so the bars and the glow move like speech.
  const talk = span(p, 0.12, 0.22) > 0 && p < 0.23 ? 1 : 0;
  const v = (k) => 0.5 + 0.5 * Math.sin(p * 900 + k * 1.7) * Math.sin(p * 310 + k);
  set('--amp', glow * (0.4 + 0.6 * talk * v(0)));
  for (let k = 0; k < BARS; k++) set(`--b${k}`, 0.2 + 0.8 * talk * Math.abs(v(k)));
  words([...scene.querySelectorAll('.ask-said i')], span(p, 0.13, 0.21));
  set('--shrunk', ease(span(p, 0.25, 0.29)));

  // The island grows out of the notch, and goes back between the acts.
  const isl = act2
    ? spring(span(p, 0.49, 0.55))
    : spring(span(p, 0.09, 0.15)) * (1 - ease(span(p, 0.33, 0.38)));
  set('--isl', isl);
  scene.dataset.state = act2
    ? p < 0.58
      ? 'read'
      : p < 0.74
        ? 'write'
        : 'done'
    : p < 0.25
      ? 'listen'
      : 'did';

  // Act two: two taps in a reply box, and the reply writes itself.
  set('--win', ease(span(p, 0.38, 0.44)));
  set('--done', act2 ? spring(span(p, 0.74, 0.8)) : spring(span(p, 0.25, 0.3)));
  words([...scene.querySelectorAll('.ask-typed i')], span(p, 0.58, 0.74));
  set('--write', p >= 0.58 && p < 0.74 ? 1 : 0);

  // Act three: "Coming up", dates found in the Library.
  set('--today', ease(span(p, 0.82, 0.9)));
  scene.querySelectorAll('.ask-today li').forEach((li, k) => {
    li.style.setProperty('--d', spring(span(p, 0.85 + k * 0.03, 0.92 + k * 0.03)).toFixed(3));
  });
}
