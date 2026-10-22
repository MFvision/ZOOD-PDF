// The helper room: ZOOD's AI panel on its Chat tab, with no document open.
// "Organize my Downloads" shows a plan first, then the loose files fly into
// their folders, with Undo. "How do I save this as docx?" offers Show me and
// Do it for me; Show me is pressed and a glowing pointer flies to Export.
// A drawing of the desktop app (packages/ui/src/ai, the Help & Support
// pointer), not a recording.
import { clamp, ease, mix, setter, span, spring, stepped } from './motion.js';

const WORDS = {
  hello: { ar: 'مساء الخير، سارة', en: 'Good evening, Sara' },
  downloads: { ar: 'التنزيلات', en: 'Downloads' },
  tabs: { ar: ['المحادثة', 'هذا المستند'], en: ['Chat', 'This document'] },
  bar: { ar: ['الرئيسية', 'الأدوات', 'تصدير'], en: ['Home', 'Tools', 'Export'] },
  ask1: { ar: 'رتّب مجلد التنزيلات', en: 'Organize my Downloads' },
  plan: { ar: 'سأرتّب 52 ملفًا حسب النوع:', en: "I'll sort 52 files by type:" },
  folders: {
    ar: [
      ['ملفات PDF', 14],
      ['صور', 32],
      ['فواتير', 6],
    ],
    en: [
      ['PDFs', 14],
      ['Pictures', 32],
      ['Invoices', 6],
    ],
  },
  organize: { ar: 'رتّب', en: 'Organize' },
  cancel: { ar: 'إلغاء', en: 'Cancel' },
  moved: { ar: 'تم. نُقل 52 ملفًا.', en: 'Done. 52 files moved.' },
  undo: { ar: 'تراجع', en: 'Undo' },
  ask2: { ar: 'كيف أحفظ هذا الملف بصيغة docx؟', en: 'How do I save this as docx?' },
  answer: {
    ar: 'من «تصدير» ثم docx. هل أريك؟',
    en: 'Use Export, then docx. Shall I show you?',
  },
  showMe: { ar: 'أرني', en: 'Show me' },
  doIt: { ar: 'نفّذها عني', en: 'Do it for me' },
  step: { ar: 'اضغط «تصدير»', en: 'Click Export' },
  placeholder: { ar: 'اسأل أي شيء…', en: 'Ask anything…' },
};

const icon = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const FOLDER = icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
const FILE = icon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>');
const UNDO = icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>');
const POINTER =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 7.5-6.2 1.7L10 19z" fill="#c9a27c" stroke="#fdfcfa" stroke-width="1.6" stroke-linejoin="round"/></svg>';
// Loose files on the left, each flying to its folder (0, 1 or 2).
const LOOSE = [0, 1, 2, 1, 0, 1, 1, 2, 0];

export function helperScene(t, escape) {
  const e = (w) => escape(t(w));
  const folders = t(WORDS.folders);
  const rows = folders
    .map(([name, n]) => `<li>${FOLDER}<span>${escape(name)}</span><em>${n}</em></li>`)
    .join('');
  const shelf = folders
    .map(([name], k) => `<span class="hp-folder" style="--k:${k}">${FOLDER}<small>${escape(name)}</small></span>`)
    .join('');
  const loose = LOOSE.map(
    (to, k) =>
      `<span class="hp-loose" style="--x:${(k % 3) * 8 + (k % 2) * 2};--y:${Math.floor(k / 3) * 6};--to:${to}">${FILE}</span>`,
  ).join('');
  const bar = t(WORDS.bar)
    .map((b, k) =>
      k === 2
        ? `<span class="hp-export">${escape(b)}<span class="hp-menu"><i>docx</i><i>xlsx</i><i>pptx</i></span></span>`
        : `<span>${escape(b)}</span>`,
    )
    .join('');
  const tabs = t(WORDS.tabs)
    .map((b, k) => `<span${k === 0 ? ' class="on"' : ''}>${escape(b)}</span>`)
    .join('');
  return `<div class="hp glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="hp-win">
      <p class="hp-bar"><span class="hp-mark"></span>${bar}</p>
      <div class="hp-body">
        <div class="hp-home">
          <b class="hp-hello">${e(WORDS.hello)}</b>
          <small>${e(WORDS.downloads)}</small>
          <div class="hp-desk">${loose}${shelf}</div>
        </div>
        <div class="hp-chat">
          <p class="hp-tabs">${tabs}</p>
          <div class="hp-list"><div class="hp-scroll">
            <p class="hp-me hp-m1">${e(WORDS.ask1)}</p>
            <div class="hp-ai hp-m2"><p>${e(WORDS.plan)}</p><ul>${rows}</ul>
              <p class="hp-btns hp-ask"><span class="hp-go">${e(WORDS.organize)}</span><span>${e(WORDS.cancel)}</span></p>
              <p class="hp-btns hp-moved"><b>${e(WORDS.moved)}</b><span>${UNDO}${e(WORDS.undo)}</span></p></div>
            <p class="hp-me hp-m3">${e(WORDS.ask2)}</p>
            <div class="hp-ai hp-m4"><p>${e(WORDS.answer)}</p>
              <p class="hp-btns"><span class="hp-show">${e(WORDS.showMe)}</span><span>${e(WORDS.doIt)}</span></p></div>
          </div></div>
          <p class="hp-input">${e(WORDS.placeholder)}</p>
        </div>
      </div>
      <span class="hp-tip">${e(WORDS.step)}</span>
      <span class="hp-pointer">${POINTER}</span>
    </div>
  </div>`;
}

// Where a point of an element sits inside the window, in pixels.
function spot(win, el, ax = 0.5, ay = 0.5) {
  const w = win.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return [r.left + r.width * ax - w.left, r.top + r.height * ay - w.top];
}

export function helperFrame(el, p, reduced) {
  const scene = el.querySelector('.hp');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.04, 0.46, 0.66, 0.9]);
  const set = (scene.__set ??= setter(scene));
  const press = (a) => span(p, a, a + 0.015) * (1 - span(p, a + 0.015, a + 0.03));

  set('--in', ease(span(p, 0, 0.06)));
  set('--drift', clamp(p));
  // The four messages, one after another.
  [0.08, 0.14, 0.52, 0.58].forEach((a, k) => set(`--m${k + 1}`, spring(span(p, a, a + 0.06))));
  set('--go', press(0.26));
  set('--org', ease(span(p, 0.29, 0.4)));
  set('--moved', spring(span(p, 0.4, 0.46)));
  // The first exchange moves up as the second one comes in.
  set('--scroll', ease(span(p, 0.5, 0.56)));
  set('--show', press(0.66));

  // Show me: the pointer leaves the button, flies to Export and points.
  const win = scene.querySelector('.hp-win');
  const from = (scene.__from ??= { at: 0 });
  // Measured once the chat has settled (after it scrolls), again if the size changes.
  const w = p < 0.6 ? 0 : win.clientWidth;
  if (from.at !== w) {
    from.at = w;
    const show = scene.querySelector('.hp-show');
    const exp = scene.querySelector('.hp-export');
    from.a = spot(win, show, 0.5, 0.7);
    from.b = spot(win, exp, 0.6, 0.75);
    // The menu opens under Export; its first row is docx.
    from.c = spot(win, exp, 0.6, 1.65);
  }
  if (!from.a) return;
  const fly = ease(span(p, 0.69, 0.79));
  const on = ease(span(p, 0.88, 0.92));
  const x = mix(mix(from.a[0], from.b[0], fly), from.c[0], on);
  const y = mix(mix(from.a[1], from.b[1], fly), from.c[1], on);
  set('--px', x);
  set('--py', y);
  set('--tx', from.b[0]);
  set('--ty', from.b[1]);
  set('--pt', ease(span(p, 0.67, 0.7)));
  set('--tip', spring(span(p, 0.79, 0.84)) * (1 - ease(span(p, 0.86, 0.88))));
  set('--click', press(0.85));
  set('--menu', spring(span(p, 0.86, 0.9)));
  set('--pick', ease(span(p, 0.93, 0.95)));
}
