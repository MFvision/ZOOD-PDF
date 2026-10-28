// The remote room: a computer and a phone side by side, and the phone runs the
// computer, one ability per scroll beat, quick to read at a glance: the laser,
// the highlighter and turning pages while presenting (Present); then the
// computer's own mouse, its shortcuts (Paste), any slideshow and the volume (Control); then
// files both ways, a file flicked up onto the computer's desktop, the shared
// clipboard and a signature (Send). A row of labels names each beat and jumps to it, and the phone
// can be tried: move over its screen and the laser or the pointer follows,
// press its buttons and they work. A drawing of the desktop app's phone
// remote (packages/ui/src/remote/phone), not a recording.
import { clamp, ease, mix, setter, span, spring } from './motion.js';

// The beats, in scroll order: where each starts and ends, which tab the phone
// shows, what the computer shows, and which point of the words it belongs to.
const BEATS = [
  { id: 'laser', s: 0.02, e: 0.13, tab: 0, screen: 'show', point: 0 },
  { id: 'mark', s: 0.13, e: 0.23, tab: 0, screen: 'show', point: 0 },
  { id: 'pages', s: 0.23, e: 0.3, tab: 0, screen: 'show', point: 0 },
  { id: 'mouse', s: 0.3, e: 0.41, tab: 1, screen: 'desk', point: 1 },
  { id: 'keys', s: 0.41, e: 0.51, tab: 1, screen: 'desk', point: 1 },
  { id: 'slides', s: 0.51, e: 0.62, tab: 1, screen: 'desk', point: 1 },
  { id: 'files', s: 0.62, e: 0.71, tab: 2, screen: 'edit', point: 2 },
  { id: 'flick', s: 0.71, e: 0.8, tab: 2, screen: 'desk', point: 2 },
  { id: 'clip', s: 0.8, e: 0.89, tab: 2, screen: 'desk', point: 2 },
  { id: 'sign', s: 0.89, e: 1, tab: 2, screen: 'edit', point: 2 },
];

const WORDS = {
  beats: {
    laser: { ar: 'ليزر', en: 'Laser' },
    mark: { ar: 'تظليل', en: 'Highlight' },
    pages: { ar: 'الصفحات', en: 'Pages' },
    mouse: { ar: 'الفأرة', en: 'Mouse' },
    keys: { ar: 'اللصق', en: 'Paste' },
    slides: { ar: 'العروض والصوت', en: 'Slides and volume' },
    files: { ar: 'الملفات', en: 'Files' },
    flick: { ar: 'مرّر ملفًا', en: 'Flick a file' },
    clip: { ar: 'الحافظة', en: 'Clipboard' },
    sign: { ar: 'التوقيع', en: 'Signature' },
  },
  show: { ar: 'اعرض كل ميزة', en: 'Show each feature' },
  connected: { ar: 'متصل بحاسوب المكتب', en: 'Connected to Office PC' },
  tabs: { ar: ['العرض', 'التحكم', 'الإرسال'], en: ['Present', 'Control', 'Send'] },
  modes: { ar: ['لوحة اللمس', 'لوحة المفاتيح', 'الوسائط'], en: ['Trackpad', 'Keyboard', 'Media'] },
  shortcuts: { ar: ['نسخ', 'لصق', 'تراجع', 'تبديل'], en: ['Copy', 'Paste', 'Undo', 'Switch app'] },
  sendTitle: { ar: 'أرسل إلى حاسوب المكتب', en: 'Send to Office PC' },
  sendBody: {
    ar: 'اختر صورًا أو ملفات ثم اسحبها للأعلى. حتى 1 جيجابايت.',
    en: 'Pick photos or files, then swipe each one up. Up to 1 GB.',
  },
  clipFromPc: { ar: 'نُسخ على الحاسوب', en: 'Copied on the computer' },
  clipNone: { ar: 'انسخ شيئًا على الحاسوب', en: 'Copy something on the computer' },
  clipText: { ar: 'اجتماع الأحد ١٠ صباحًا', en: 'Meeting Sunday 10am' },
  copy: { ar: 'نسخ', en: 'Copy' },
  copied: { ar: 'نُسخ', en: 'Copied' },
  clipPaste: { ar: 'الصق على الحاسوب', en: 'Paste on the computer' },
  clipPasteBody: { ar: 'ما نسخته على الجوال', en: 'What you copied here' },
  pcCopied: { ar: 'نُسخ', en: 'Copied' },
  docTitle: { ar: 'هذا المستند', en: 'This document' },
  tools: { ar: ['ليزر', 'قلم', 'تظليل'], en: ['Laser', 'Pen', 'Highlighter'] },
  notes: { ar: 'الملاحظات', en: 'Notes' },
  note: { ar: 'اذكر نمو الربع الثالث.', en: 'Mention third-quarter growth.' },
  pageOf: { ar: ['صفحة 3 من 12', 'صفحة 4 من 12'], en: ['Page 3 of 12', 'Page 4 of 12'] },
  slide3: { ar: 'نتائج الربع الثالث', en: 'Third-quarter results' },
  slide4: { ar: 'الخطة القادمة', en: 'What comes next' },
  plan: {
    ar: ['فرعان جديدان', 'فريق مبيعات أكبر', 'تطبيق للعملاء'],
    en: ['Two new branches', 'A bigger sales team', 'An app for customers'],
  },
  notesApp: { ar: 'ملاحظات', en: 'Notes' },
  typed: { ar: 'اجتماع الأحد ١٠ صباحًا', en: 'Meeting Sunday 10am' },
  deck: { ar: 'عرض المبيعات', en: 'Sales deck' },
  deckSlides: { ar: ['الأهداف', 'النتائج', 'الخطة'], en: ['Goals', 'Results', 'Plan'] },
  typeHere: { ar: 'اكتب هنا…', en: 'Type here…' },
  rows: {
    ar: [
      ['احفظ هذا الملف على جوالي', 'الملف المفتوح كما هو الآن.'],
      ['صوّر ورقة', 'ويحوّلها الجهاز إلى PDF.'],
      ['وقّع بإصبعك', 'ثم ضعه على الصفحة.'],
    ],
    en: [
      ['Save this PDF on my phone', 'The open document, as it is now.'],
      ['Scan a paper page', 'The computer makes it a PDF.'],
      ['Sign with your finger', 'Then place it on the page.'],
    ],
  },
  saved: { ar: 'حُفظ في جوالك', en: 'Saved on your phone' },
  flickName: { ar: 'إيصال.pdf', en: 'Receipt.pdf' },
  flickHint: { ar: 'اسحب للأعلى لإرساله إلى الجهاز', en: 'Swipe up to send it to the computer' },
  fromPc: { ar: 'من الجهاز', en: 'From the computer' },
  pcName: { ar: 'ملاحظات.txt', en: 'Notes.txt' },
  save: { ar: 'حفظ', en: 'Save' },
  done: { ar: 'تم', en: 'Done' },
  drawSig: { ar: 'ارسم توقيعك', en: 'Draw your signature' },
  signPage: { ar: 'وقّع الصفحة 1', en: 'Sign page 1' },
  signed: { ar: 'تم التوقيع', en: 'Signed' },
  app: { ar: 'محرر PDF', en: 'ZOOD PDF' },
  contract: { ar: 'عقد خدمة', en: 'Service agreement' },
  signature: { ar: 'التوقيع', en: 'Signature' },
  newPage: { ar: 'صفحة جديدة', en: 'New page' },
  keys: {
    ar: ['ضصثقفغعهخح', 'شسيبلاتنمك', 'ئءؤرىةوزظ'],
    en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  },
};

const icon = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const ICONS = {
  present: icon('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/>'),
  pointer: icon('<path d="M5 3l14 7-6 2-2 6z"/>'),
  file: icon(
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  ),
  camera: icon('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  pen: icon('<path d="M4 20l4-1 11-11-3-3L5 16z"/>'),
  marker: icon('<path d="M9 15l-3 3v2h4l3-3M9 15l7-10 3 3-7 10z"/>'),
  zap: icon('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  kbd: icon(
    '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  ),
  left: icon('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  right: icon('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  up: icon('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: icon('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  voldown: icon('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 12h4"/>'),
  mute: icon('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>'),
  volup: icon('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 12h5M18 9.5v5"/>'),
  play: icon('<path d="M7 5v14l11-7z"/>'),
  sign: icon('<path d="M3 17c3-6 5-9 7-9s-1 8 1 8 3-5 5-5 1 4 3 4 2-1 2-1"/>'),
  check: icon('<path d="m5 12.5 4.5 4.5L19 7.5"/>', ' stroke-width="3"'),
  send: icon('<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>'),
  upload: icon('<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>'),
  copy: icon(
    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  ),
  paste: icon('<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/>'),
  undo: icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  layers: icon('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  music: icon(
    '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  ),
  speaker: icon(
    '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>',
  ),
};
const cursor =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2.5 19 13l-6.2 1.2L9.4 20.5Z" fill="#fdfcfa" stroke="#041e42" stroke-width="1.6" stroke-linejoin="round"/></svg>';
// The signature, drawn on the phone and then on the page.
const SIG =
  'M6 28c6-14 12-20 15-14s-6 16-2 14 9-16 13-12-2 12 2 10 8-10 12-8 0 8 4 7 10-6 14-6 8 4 14 2 10-6 14-8';
const sig = (cls) =>
  `<svg class="${cls}" viewBox="0 0 100 40" aria-hidden="true"><path pathLength="1" d="${SIG}"/></svg>`;

// The bars of the slide's chart: their heights, and where the laser visits them.
const BARS = [0.35, 0.5, 0.45, 0.68, 0.8, 0.92];
const barTop = (k) => [15 + k * 14, 32 + 54 * (1 - BARS[k]) - 3];

// Where things sit on the phone's screen, in % of its width and height (the
// row layouts in the CSS place them there).
const STAGE = { x: 6, y: 12, w: 88, h: 25.5 };
const PAD = { x: 5, y: 19, w: 90, h: 39 };
const AT = {
  tools: [22, 50, 78].map((x) => [x, 44]),
  prev: [20, 74],
  next: [80, 74],
  tabs: [17, 50, 83].map((x) => [x, 92]),
  modes: [19.3, 50, 80.7].map((x) => [x, 14]),
  paste: [38.5, 64],
  arrowR: [84.5, 73.25],
  volup: [61.5, 64],
  send: [50, 21.5],
  copy: [27.5, 46],
  rows: [59.25, 68.75, 78.25].map((y) => [50, y]),
  signBtn: [50, 79],
};

export function remoteScene(t, escape, frame) {
  const e = (w) => escape(t(w));
  const chips = BEATS.map(
    (b, k) =>
      `<li><button type="button" data-go="${k}" style="--k:${k}">${e(WORDS.beats[b.id])}</button></li>`,
  ).join('');
  const slides = [
    `<div class="rm-slide s3"><p class="rm-stitle"><mark></mark><span>${e(WORDS.slide3)}</span></p><div class="rm-bars">${BARS.map((h) => `<i style="--h:${h}"></i>`).join('')}</div></div>`,
    `<div class="rm-slide s4"><p class="rm-stitle"><span>${e(WORDS.slide4)}</span></p><ul class="rm-plan">${t(
      WORDS.plan,
    )
      .map((x) => `<li><b></b>${escape(x)}</li>`)
      .join('')}</ul></div>`,
  ].join('');
  const deck = () => `<div class="rm-show">${slides}<span class="rm-dot"></span></div>`;
  const deckSlides = t(WORDS.deckSlides)
    .map(
      (s, k) =>
        `<div class="rm-dslide d${k}"><b>${escape(s)}</b><i></i><i></i><small>${k + 1} / 3</small></div>`,
    )
    .join('');
  const typed = [...t(WORDS.typed)].map((c) => `<i>${escape(c)}</i>`).join('');
  const tabs = t(WORDS.tabs)
    .map(
      (x, k) =>
        `<span class="rm-tab" data-k="tab${k}">${[ICONS.present, ICONS.pointer, ICONS.send][k]}${escape(x)}</span>`,
    )
    .join('');
  const tools = t(WORDS.tools)
    .map(
      (x, k) =>
        `<span class="rm-tool t${k}" data-k="tool${k}">${[ICONS.zap, ICONS.pen, ICONS.marker][k]}${escape(x)}</span>`,
    )
    .join('');
  const rows = t(WORDS.rows)
    .map(
      ([a, b], k) =>
        `<span class="rm-row" data-k="row${k}"><i>${[ICONS.file, ICONS.camera, ICONS.sign][k]}</i><b>${escape(a)}</b><small>${escape(b)}</small></span>`,
    )
    .join('');
  const modes = t(WORDS.modes)
    .map(
      (x, k) =>
        `<span class="rm-mode m${k}" data-k="mode${k}">${[ICONS.pointer, ICONS.kbd, ICONS.music][k]}${escape(x)}</span>`,
    )
    .join('');
  const shortcuts = t(WORDS.shortcuts)
    .map(
      (x, k) =>
        `<span data-k="sc${k}">${[ICONS.copy, ICONS.paste, ICONS.undo, ICONS.layers][k]}<small>${escape(x)}</small></span>`,
    )
    .join('');
  const keyRows = t(WORDS.keys)
    .map((r) => `<span>${[...r].map((c) => `<i>${escape(c)}</i>`).join('')}</span>`)
    .join('');
  const pages = t(WORDS.pageOf)
    .map((x, k) => `<b class="pg${k + 3}">${escape(x)}</b>`)
    .join('');
  return `<div class="rm glassroom">
    <nav class="rm-chips glass" aria-label="${e(WORDS.show)}"><ol>${chips}</ol></nav>
    <div class="rm-art" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="rm-mon"><div class="rm-screen">
      <div class="rm-layer rm-l-show">${deck()}</div>
      <div class="rm-layer rm-l-desk">
        <div class="rm-wapp rm-notes"><p class="rm-wbar">${e(WORDS.notesApp)}</p><p class="rm-ntext">${typed}<u></u></p><span class="rm-pcopied">${ICONS.check}${e(WORDS.pcCopied)}</span></div>
        <div class="rm-wapp rm-deck"><p class="rm-wbar">${e(WORDS.deck)}</p><div class="rm-dview">${deckSlides}</div></div>
        <div class="rm-dock"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="rm-hud"><span>${ICONS.speaker}</span><b><i></i></b></div>
        <span class="rm-dfile"><i>${ICONS.file}</i><small>${e(WORDS.flickName)}</small></span>
        <span class="rm-click"></span>
        <span class="rm-ptr">${cursor}</span>
      </div>
      <div class="rm-layer rm-l-edit">
        <div class="rm-ebar">${e(WORDS.app)}</div>
        <div class="rm-side"><i></i><i></i><i class="rm-newp"><small>${e(WORDS.newPage)}</small></i></div>
        <div class="rm-paper"><p class="rm-ptitle">${e(WORDS.contract)}</p><div class="lib-bars"><i></i><i></i><i></i></div><div class="lib-bars"><i></i><i></i></div>
          <div class="rm-sigline"><small>${e(WORDS.signature)}</small>${sig('rm-sig-pc')}</div></div>
      </div>
    </div><div class="rm-neck"></div><div class="rm-foot"></div></div>
    <div class="rm-phone"><div class="rm-pscreen">
      <p class="rm-status"><i></i>${e(WORDS.connected)}</p>
      <div class="rm-panel rm-p0">
        <div class="rm-stage">${slides}<span class="rm-dot"></span></div>
        <div class="rm-tools">${tools}</div>
        <div class="rm-pnotes"><b>${e(WORDS.notes)}</b><span>${e(WORDS.note)}</span><em>02:14</em></div>
        <div class="rm-nav"><span class="rm-big" data-k="prev">${ICONS.left}</span><span class="rm-pg">${pages}</span><span class="rm-big rm-next" data-k="next">${ICONS.right}</span></div>
      </div>
      <div class="rm-panel rm-p1">
        <div class="rm-modes">${modes}</div>
        <div class="rm-pad"><div class="rm-dots"></div><div class="rm-dots rm-lit"></div></div>
        <div class="rm-keys rm-short">${shortcuts}</div>
        <div class="rm-keys rm-media"><span data-k="voldown">${ICONS.voldown}</span><span data-k="mute">${ICONS.mute}</span><span data-k="volup">${ICONS.volup}</span><span data-k="play">${ICONS.play}</span></div>
        <div class="rm-keys rm-arrows"><span data-k="arrowL">${ICONS.left}</span><span data-k="arrowU">${ICONS.up}</span><span data-k="arrowD">${ICONS.down}</span><span data-k="arrowR">${ICONS.right}</span></div>
      </div>
      <div class="rm-panel rm-p2">
        <div class="rm-send" data-k="send"><i>${ICONS.upload}</i><b>${e(WORDS.sendTitle)}</b><small>${e(WORDS.sendBody)}</small></div>
        <div class="rm-clip">
          <div class="rm-cfrom"><small>${ICONS.copy}${e(WORDS.clipFromPc)}</small><p><span class="rm-cnone">${e(WORDS.clipNone)}</span><span class="rm-ctext">${e(WORDS.clipText)}</span></p><span class="rm-cbtn" data-k="copy"><span class="rm-cb0">${e(WORDS.copy)}</span><span class="rm-cb1">${ICONS.check}${e(WORDS.copied)}</span></span></div>
          <div class="rm-cto"><small>${ICONS.paste}${e(WORDS.clipPaste)}</small><p>${e(WORDS.clipPasteBody)}</p></div>
        </div>
        <p class="rm-dtitle">${e(WORDS.docTitle)}</p>${rows}
        <p class="rm-toast">${ICONS.check}${e(WORDS.saved)}</p>
        <div class="rm-signpad"><small>${e(WORDS.drawSig)}</small>${sig('rm-sig-phone')}<span class="rm-signbtn" data-k="signBtn">${e(WORDS.signPage)}</span></div>
      </div>
      <div class="rm-flick"><span class="rm-fglow"></span><span class="rm-fwave"></span>
        <div class="rm-fsend"><div class="rm-fcard">${ICONS.file}</div><p class="rm-fname">${e(WORDS.flickName)}</p><p class="rm-fhint">${ICONS.up}${e(WORDS.flickHint)}</p></div>
        <div class="rm-fcatch"><small>${e(WORDS.fromPc)}</small><div class="rm-fcard">${ICONS.file}</div><p class="rm-fname">${e(WORDS.pcName)}</p><span class="rm-fbtns"><span class="rm-fsave" data-k="fsave">${e(WORDS.save)}</span><span>${e(WORDS.done)}</span></span></div>
      </div>
      <div class="rm-sheet"><p class="rm-input">${typed}<u></u><small>${e(WORDS.typeHere)}</small></p><div class="rm-krows">${keyRows}<span><i class="sp"></i></span></div></div>
      <nav class="rm-tabs">${tabs}</nav>
      <span class="rm-touch"></span>
    </div>${frame}</div>
    <div class="rm-fly glass"><span class="rm-fly-pdf">${ICONS.file}</span><span class="rm-fly-cam">${ICONS.camera}</span></div>
    <p class="rm-signed glass">${ICONS.check}${e(WORDS.signed)}</p>
    </div>
  </div>`;
}

// A path of [t, x, y] points, eased from one to the next.
function along(points, t) {
  if (t <= points[0][0]) return points[0].slice(1);
  for (let k = 1; k < points.length; k++) {
    const [t1, x1, y1] = points[k];
    const [t0, x0, y0] = points[k - 1];
    if (t <= t1) {
      const f = ease(span(t, t0, t1));
      return [mix(x0, x1, f), mix(y0, y1, f)];
    }
  }
  return points.at(-1).slice(1);
}
const inside = (t, a, b) => t >= a && t < b;
const onStage = ([u, v]) => [STAGE.x + (u * STAGE.w) / 100, STAGE.y + (v * STAGE.h) / 100];

// What the scroll shows at beat b, t of the way through it.
function script(b, t, rtl, scene) {
  // Rows the phone lays out right to left in Arabic are mirrored here.
  const X = ([x, y]) => [rtl ? 100 - x : x, y];
  const s = {
    tab: BEATS[b].tab,
    screen: BEATS[b].screen,
    touch: null,
    press: '',
    tool: 0,
    laser: null,
    mark: 0,
    page: 3,
    turn: 1,
    ptr: null,
    click: 0,
    focus: '',
    kb: 0,
    typed: 0,
    deck: 0,
    hud: 0,
    level: 0.45,
    fly: 0,
    flyon: 0,
    back: false,
    saved: 0,
    newp: 0,
    pad: 0,
    sigd: 0,
    sigp: 0,
    signed: 0,
    fon: 0,
    fk: 0,
    fglow: 0,
    fwave: 0,
    fland: 0,
    fcatch: 0,
    mode: 0,
    pcsel: 0,
    pccopied: 0,
    clip: 0,
    copied: 0,
  };
  const id = BEATS[b].id;
  const tops = BARS.map((_, k) => barTop(k));
  if (b >= 1) s.tool = 2;
  if (b >= 2) s.mark = 1;
  if (b >= 3) [s.page, s.mark] = [4, 0];
  if (b >= 4) [s.ptr, s.focus] = [[22, 34], 'notes'];
  if (b >= 5) s.typed = 1;
  if (b >= 6) [s.deck, s.ptr, s.focus, s.level] = [2, [70, 42], 'deck', 0.6];
  if (b >= 7) [s.saved, s.newp] = [0, 1];
  if (b >= 8) s.fland = 1;
  if (b >= 9) [s.clip, s.copied, s.pcsel] = [1, 1, 1];

  if (id === 'laser') {
    const path = [[0.08, 30, 92], ...tops.map(([u, v], k) => [0.14 + k * 0.13, u, v])];
    const at = along(path, t);
    s.tool = 0;
    s.touch = inside(t, 0.06, 0.94) ? onStage(at) : null;
    s.laser = inside(t, 0.12, 0.92) ? at : null;
  } else if (id === 'mark') {
    const from = rtl ? 90 : 10;
    const to = rtl ? 30 : 70;
    if (t < 0.24) {
      s.touch = along(
        [
          [0, ...onStage([60, 80])],
          [0.14, ...X(AT.tools[2])],
        ],
        t,
      );
      s.press = inside(t, 0.14, 0.2) ? 'tool2' : '';
      s.tool = t < 0.18 ? 0 : 2;
    } else {
      const [u] = along(
        [
          [0.3, from, 18],
          [0.75, to, 18],
        ],
        t,
      );
      s.touch = t < 0.88 ? onStage([u, 18]) : null;
      s.mark = span(t, 0.32, 0.75);
    }
  } else if (id === 'pages') {
    const next = X(AT.next);
    s.touch =
      t < 0.85
        ? along(
            [
              [0, ...onStage(rtl ? [40, 18] : [70, 18])],
              [0.3, ...next],
            ],
            t,
          )
        : null;
    s.press = inside(t, 0.34, 0.44) ? 'next' : '';
    s.page = t < 0.4 ? 3 : 4;
    s.turn = ease(span(t, 0.4, 0.6));
    s.mark = t < 0.4 ? 1 : 0;
  } else if (id === 'mouse') {
    s.tab = t < 0.14 ? 0 : 1;
    s.screen = t < 0.14 ? 'show' : 'desk';
    s.press = inside(t, 0.1, 0.16) ? 'tab1' : '';
    s.touch = along(
      [
        [0, ...X(AT.next)],
        [0.1, ...X(AT.tabs[1])],
        [0.28, 72, 50],
        [0.66, 32, 26],
      ],
      t,
    );
    if (t > 0.88) s.touch = null;
    s.ptr = along(
      [
        [0.28, 82, 78],
        [0.66, 22, 34],
      ],
      t,
    );
    s.click = span(t, 0.72, 0.86);
    s.press = s.press || (inside(t, 0.72, 0.78) ? 'pad' : '');
    s.focus = t > 0.76 ? 'notes' : '';
  } else if (id === 'keys') {
    // The Paste shortcut, sent as the computer's own keys: the words land in Notes.
    s.typed = t > 0.38 ? 1 : 0;
    s.touch =
      t < 0.82
        ? along(
            [
              [0, 40, 40],
              [0.3, ...X(AT.paste)],
            ],
            t,
          )
        : null;
    s.press = inside(t, 0.32, 0.4) ? 'sc1' : '';
  } else if (id === 'slides') {
    s.typed = 1;
    s.kb = 0;
    s.touch = along(
      [
        [0, 46, 40],
        [0.12, 46, 40],
        [0.3, 70, 30],
        [0.42, 70, 30],
        [0.5, ...AT.arrowR],
        [0.66, ...AT.arrowR],
        [0.72, ...X(AT.modes[2])],
        [0.8, ...AT.volup],
      ],
      t,
    );
    if (t > 0.94) s.touch = null;
    s.ptr = along(
      [
        [0.12, 22, 34],
        [0.3, 70, 42],
      ],
      t,
    );
    s.click = span(t, 0.32, 0.44);
    s.focus = t > 0.36 ? 'deck' : 'notes';
    s.press = inside(t, 0.32, 0.38)
      ? 'pad'
      : inside(t, 0.52, 0.57) || inside(t, 0.6, 0.65)
        ? 'arrowR'
        : inside(t, 0.72, 0.77)
          ? 'mode2'
          : inside(t, 0.82, 0.88)
            ? 'volup'
            : '';
    s.mode = t < 0.74 ? 0 : 2;
    s.deck = t < 0.55 ? 0 : t < 0.63 ? 1 : 2;
    s.hud = spring(span(t, 0.84, 0.92));
    s.level = mix(0.45, 0.6, span(t, 0.84, 0.9));
  } else if (id === 'files') {
    s.tab = t < 0.13 ? 1 : 2;
    s.screen = t < 0.13 ? 'desk' : 'edit';
    s.touch = along(
      [
        [0, ...AT.volup],
        [0.1, ...X(AT.tabs[2])],
        [0.28, ...AT.rows[0]],
        [0.62, ...AT.rows[0]],
        [0.7, ...AT.rows[1]],
      ],
      t,
    );
    if (t > 0.9) s.touch = null;
    s.press = inside(t, 0.1, 0.15)
      ? 'tab2'
      : inside(t, 0.28, 0.33)
        ? 'row0'
        : inside(t, 0.7, 0.75)
          ? 'row1'
          : '';
    const out = span(t, 0.33, 0.55);
    const back = span(t, 0.75, 0.92);
    s.back = t > 0.6;
    s.fly = s.back ? 1 - ease(back) : ease(out);
    s.flyon = s.back ? Math.sin(back * Math.PI) : Math.sin(out * Math.PI);
    s.saved = spring(span(t, 0.55, 0.6)) * (1 - span(t, 0.7, 0.74));
    s.newp = spring(span(t, 0.9, 0.98));
  } else if (id === 'flick') {
    // A file flicked up off the phone lands on the computer's desktop, in a
    // glow and a wave of light; then one from the computer drops in.
    s.fon = ease(span(t, 0, 0.08)) * (1 - ease(span(t, 0.94, 1)));
    s.touch =
      t < 0.36
        ? along(
            [
              [0.04, 50, 36],
              [0.16, 50, 36],
              [0.34, 50, 6],
            ],
            t,
          )
        : inside(t, 0.72, 0.9)
          ? along(
              [
                [0.72, 60, 60],
                [0.8, ...X([31, 59])],
              ],
              t,
            )
          : null;
    s.fk = ease(span(t, 0.16, 0.34));
    s.fglow = Math.max(
      Math.sin(span(t, 0.14, 0.5) * Math.PI),
      Math.sin(span(t, 0.52, 0.86) * Math.PI),
    );
    s.fwave = span(t, 0.2, 0.42);
    s.fland = spring(span(t, 0.36, 0.5));
    s.fcatch = spring(span(t, 0.54, 0.7));
    s.press = inside(t, 0.8, 0.86) ? 'fsave' : '';
  } else if (id === 'clip') {
    // Copied on the computer, it is on the phone at once: one tap copies it there.
    s.focus = 'notes';
    s.pcsel = ease(span(t, 0.04, 0.18));
    s.pccopied = spring(span(t, 0.18, 0.26)) * (1 - span(t, 0.56, 0.62));
    s.clip = spring(span(t, 0.26, 0.38));
    s.copied = t > 0.52 ? 1 : 0;
    s.touch = inside(t, 0.3, 0.84)
      ? along(
          [
            [0.3, 60, 70],
            [0.46, ...X(AT.copy)],
          ],
          t,
        )
      : null;
    s.press = inside(t, 0.47, 0.53) ? 'copy' : '';
  } else if (id === 'sign') {
    s.pad = spring(span(t, 0.12, 0.22)) * (1 - span(t, 0.72, 0.8));
    s.sigd = span(t, 0.25, 0.55);
    s.sigp = ease(span(t, 0.72, 0.88));
    s.signed = spring(span(t, 0.86, 0.94));
    if (t < 0.22) {
      s.touch = along(
        [
          [0, ...AT.rows[1]],
          [0.08, ...AT.rows[2]],
        ],
        t,
      );
      s.press = inside(t, 0.08, 0.13) ? 'row2' : '';
    } else if (t < 0.56) {
      // The finger is the pen: it follows the signature as it is drawn.
      const path = scene.querySelector('.rm-sig-phone path');
      if (path?.getTotalLength) {
        const at = path.getPointAtLength(s.sigd * path.getTotalLength());
        s.touch = [10 + at.x * 0.8, 55 + (at.y / 40) * 18];
      }
    } else if (t < 0.8) {
      s.touch = along(
        [
          [0.56, 80, 66],
          [0.64, ...AT.signBtn],
        ],
        t,
      );
      s.press = inside(t, 0.64, 0.71) ? 'signBtn' : '';
    }
  }
  return s;
}

const LIVE_FOR = 1600;

// The phone answers the visitor's own finger or mouse for a moment, then the
// scroll takes over again.
function wire(el, scene) {
  const screen = scene.querySelector('.rm-pscreen');
  const redraw = () => remoteFrame(el, scene.__p ?? 0, scene.__reduced);
  const where = (event) => {
    const r = screen.getBoundingClientRect();
    return [((event.clientX - r.left) / r.width) * 100, ((event.clientY - r.top) / r.height) * 100];
  };
  let timer = 0;
  const touch = (event, down) => {
    scene.__live = { at: where(event), time: performance.now(), down };
    clearTimeout(timer);
    timer = setTimeout(redraw, LIVE_FOR + 50);
    redraw();
  };
  screen.addEventListener('pointermove', (event) => touch(event, scene.__live?.down ?? false));
  screen.addEventListener('pointerleave', () => {
    if (scene.__live) scene.__live.down = false;
  });
  screen.addEventListener('pointerup', (event) => touch(event, false));
  screen.addEventListener('pointerdown', (event) => {
    const key =
      event.target.closest('[data-k]')?.dataset.k ?? (event.target.closest('.rm-pad') ? 'pad' : '');
    const live = (scene.__nudge ??= { beat: -1, page: 0, deck: 0, vol: 0, click: 0 });
    if (key === 'next' || key === 'prev') live.page += 1;
    if (key === 'arrowR' || key === 'arrowL') live.deck += key === 'arrowR' ? 1 : 2;
    if (key === 'volup' || key === 'voldown' || key === 'mute') live.vol = performance.now();
    if (key === 'pad') live.click = performance.now();
    scene.__pressKey = key;
    touch(event, true);
  });
  // The labels jump to their beat.
  scene.querySelectorAll('.rm-chips button').forEach((button) =>
    button.addEventListener('click', () => {
      const beat = BEATS[+button.dataset.go];
      const top = el.getBoundingClientRect().top + scrollY;
      const room = el.offsetHeight - innerHeight;
      const at = beat.s + (beat.e - beat.s) * (beat.id === 'laser' ? 0.5 : 0.62);
      scrollTo({ top: top + room * at, behavior: scene.__reduced ? 'auto' : 'smooth' });
    }),
  );
}

export function remoteFrame(el, p, reduced) {
  const scene = el.querySelector('.rm');
  if (!scene) return;
  scene.__p = p;
  scene.__reduced = reduced;
  if (!scene.__wired) {
    scene.__wired = true;
    wire(el, scene);
  }
  const set = (scene.__set ??= setter(scene));
  const rtl = document.documentElement.dir === 'rtl';
  set('--drift', clamp(p));
  set('--in', ease(span(p, 0, 0.04)));
  set('--phone', spring(span(p, 0, 0.05)));

  let b = BEATS.findLastIndex((x) => p >= x.s);
  if (b < 0) b = 0;
  // With Reduce Motion each beat is one still picture: its finished state.
  const t = reduced
    ? ({ files: 0.99, flick: 0.76, sign: 0.97 }[BEATS[b].id] ?? 0.9)
    : span(p, BEATS[b].s, BEATS[b].e);
  const s = script(b, t, rtl, scene);

  // The visitor's own touch, while it lasts.
  const live =
    scene.__live && performance.now() - scene.__live.time < LIVE_FOR ? scene.__live : null;
  const nudge =
    scene.__nudge?.beat === b
      ? scene.__nudge
      : (scene.__nudge = { beat: b, page: 0, deck: 0, vol: 0, click: 0 });
  if (live) {
    const [x, y] = live.at;
    s.touch = [x, y];
    s.press = live.down ? scene.__pressKey || 'pad' : '';
    if (s.tab === 0) {
      const u = ((x - STAGE.x) / STAGE.w) * 100;
      const v = ((y - STAGE.y) / STAGE.h) * 100;
      if (u >= 0 && u <= 100 && v >= 0 && v <= 100) s.laser = [u, v];
    } else if (s.tab === 1) {
      const u = clamp(((x - PAD.x) / PAD.w) * 100, 2, 96);
      const v = clamp(((y - PAD.y) / PAD.h) * 100, 2, 90);
      if (y <= PAD.y + PAD.h) s.ptr = [u, v];
    }
  }
  if (nudge.page % 2) [s.page, s.turn, s.mark] = [s.page === 3 ? 4 : 3, 1, 0];
  s.deck = (s.deck + nudge.deck) % 3;
  const since = (at) => (at ? (performance.now() - at) / 600 : 9);
  if (since(nudge.vol) < 2) [s.hud, s.level] = [1, 0.6];
  if (since(nudge.click) < 1) s.click = since(nudge.click);
  if (nudge.vol || nudge.click) {
    clearTimeout(scene.__after);
    scene.__after = setTimeout(() => remoteFrame(el, scene.__p, scene.__reduced), 1300);
  }

  scene.dataset.beat = BEATS[b].id;
  scene.dataset.tab = s.tab;
  scene.dataset.screen = s.screen;
  scene.dataset.tool = s.tool;
  scene.dataset.page = s.page;
  scene.dataset.deck = s.deck;
  scene.dataset.focus = s.focus;
  scene.dataset.mode = s.mode;
  scene.classList.toggle('rm-copied', s.copied > 0);
  scene.classList.toggle('rm-back', s.back);
  scene.querySelectorAll('.rm-chips button').forEach((c, k) => c.classList.toggle('on', k === b));
  el.querySelectorAll('.ring-words .points li').forEach((li, k) =>
    li.classList.toggle('now', k === BEATS[b].point),
  );
  scene
    .querySelectorAll('[data-k]')
    .forEach((x) => x.classList.toggle('down', x.dataset.k === s.press));

  set('--touch', s.touch ? 1 : 0);
  if (s.touch) {
    set('--tx', `${s.touch[0].toFixed(2)}%`);
    set('--ty', `${s.touch[1].toFixed(2)}%`);
  }
  set('--press', s.press ? 1 : 0);
  // The lit dots under the finger, on the trackpad.
  if (s.touch && s.tab === 1) {
    set('--gx', `${(((s.touch[0] - PAD.x) / PAD.w) * 100).toFixed(1)}%`);
    set('--gy', `${(((s.touch[1] - PAD.y) / PAD.h) * 100).toFixed(1)}%`);
  }
  set('--glow', s.touch && s.tab === 1 && s.touch[1] < PAD.y + PAD.h ? 1 : 0);
  set('--laser', s.laser ? 1 : 0);
  if (s.laser) {
    set('--lx', `${s.laser[0].toFixed(2)}%`);
    set('--ly', `${s.laser[1].toFixed(2)}%`);
  }
  set('--mark', s.mark);
  set('--turn', s.turn);
  set('--ptr', s.ptr ? 1 : 0);
  if (s.ptr) {
    set('--px', `${s.ptr[0].toFixed(2)}%`);
    set('--py', `${s.ptr[1].toFixed(2)}%`);
  }
  set('--click', s.click);
  set('--kb', s.kb);
  const letters = scene.querySelectorAll('.rm-ntext i, .rm-input i');
  const half = letters.length / 2;
  const typed = Math.round(half * s.typed);
  letters.forEach((c, k) => c.classList.toggle('on', k % half < typed));
  scene.classList.toggle('rm-typing', typed > 0 && typed < half);
  scene.classList.toggle('rm-has-text', typed > 0);
  set('--hud', s.hud);
  set('--level', s.level);
  set('--fly', s.fly);
  set('--flyon', s.flyon);
  set('--saved', s.saved);
  set('--newp', s.newp);
  set('--pad', s.pad);
  set('--sigd', s.sigd);
  set('--sigp', s.sigp);
  set('--signed', s.signed);
  set('--fon', s.fon);
  set('--fk', s.fk);
  set('--fglow', s.fglow);
  set('--fwave', s.fwave);
  set('--fland', s.fland);
  set('--fcatch', s.fcatch);
  set('--pcsel', s.pcsel);
  set('--pccopied', s.pccopied);
  set('--clip', s.clip);
}
