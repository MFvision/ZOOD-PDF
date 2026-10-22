// The phone room: the phone stays in the middle and turns to face you while
// the room drifts behind it. Glass cards slide out of it one at a time, each
// is pressed, ticks, and the phone's screen changes to what that card does.
// The screens are the app's own (tools/capture-screens.mjs).
import { clamp, ease, setter, span, spring, stepped } from './motion.js';

const camera =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const files =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const bolt =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
const check =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

const WORDS = {
  scan: { ar: 'امسح مستندًا', en: 'Scan a document' },
  scanSub: { ar: 'يقرأ النص العربي', en: 'Reads Arabic text' },
  recent: { ar: 'آخر الملفات', en: 'Recent files' },
  rows: {
    ar: ['عقد الإيجار', 'تقرير الربع', 'فاتورة 1047'],
    en: ['Lease', 'Quarterly report', 'Invoice 1047'],
  },
  shortcut: { ar: 'اختصار', en: 'Shortcut' },
  open: { ar: 'افتح آخر ملف', en: 'Open the last document' },
  tabs: {
    ar: ['الرئيسية', 'ملفاتي', 'إنشاء', 'الأدوات', 'أنا'],
    en: ['Home', 'My files', 'Create', 'Tools', 'Me'],
  },
  openWith: { ar: 'يفتح التطبيق على', en: 'Open with' },
  lastPlace: { ar: 'حيث توقفت', en: 'Where I left off' },
  icon: { ar: 'أيقونة التطبيق', en: 'App icon' },
};
// The app's own icon choices (apps/ios … AppIconPreview*), in its order.
const ICONS = ['navy', 'paper', 'sky', 'black', 'bronze'];
const tabIcon = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const TAB_ICONS = [
  tabIcon('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>'),
  tabIcon('<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  tabIcon('<path d="M12 6v12M6 12h12"/>'),
  tabIcon(
    '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z"/>',
  ),
  tabIcon('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
];
// The phone's screens, and which one each card brings up, in order.
const SCREENS = ['scan', 'home', 'read'];
const SHOWS = [0, 1, 2, 1, 1];

export function phoneScene(t, escape, media, frame) {
  const [w, h] = media.size('phone');
  const imgs = SCREENS.map(
    (s) =>
      `<img alt="" width="${w}" height="${h}" decoding="async" data-screen="phone ${s}" data-src="${escape(media.still('phone', s))}">`,
  ).join('');
  const tick = `<span class="ph-tick">${check}</span>`;
  const rows = t(WORDS.rows)
    .map((r) => `<li><span class="ph-file">${files}</span>${escape(r)}</li>`)
    .join('');
  return `<div class="ph glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="ph-halo"></div>
    <div class="ph-space">
      <div class="ph-phone"><div class="screen">${imgs}<div class="ph-scanline"></div></div>${frame}</div>
      <div class="ph-card glass c0" style="--k:0"><span class="ph-icon">${camera}</span><span class="ph-text"><b>${escape(t(WORDS.scan))}</b><small>${escape(t(WORDS.scanSub))}</small></span>${tick}</div>
      <div class="ph-card glass c1 ph-widget" style="--k:1"><b class="ph-wtitle">${escape(t(WORDS.recent))}</b><ul>${rows}</ul>${tick}</div>
      <div class="ph-card glass c3 ph-tabs" style="--k:3"><span class="ph-tabrow">${t(WORDS.tabs)
        .map(
          (x, k) =>
            `<span class="${k === 2 ? 'ph-plus' : ''}"><i>${TAB_ICONS[k]}</i>${escape(x)}</span>`,
        )
        .join(
          '',
        )}</span><small class="ph-open">${escape(t(WORDS.openWith))}: <b>${escape(t(WORDS.lastPlace))}</b></small>${tick}</div>
      <div class="ph-card glass c4 ph-icons" style="--k:4"><b class="ph-wtitle">${escape(t(WORDS.icon))}</b><span class="ph-irow">${ICONS.map(
        (c, k) =>
          `<img alt="" width="64" height="64" decoding="async" class="${k === 4 ? 'pick' : ''}" src="${new URL(`../assets/brand/icons/${c}.webp`, import.meta.url).href}">`,
      ).join('')}</span>${tick}</div>
      <div class="ph-card glass c2" style="--k:2"><span class="ph-icon bolt">${bolt}</span><span class="ph-text"><small>${escape(t(WORDS.shortcut))}</small><b>${escape(t(WORDS.open))}</b></span>${tick}</div>
    </div>
  </div>`;
}

export function phoneFrame(el, p, reduced) {
  const scene = el.querySelector('.ph');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.08, 0.34, 0.5, 0.66, 0.82, 0.97]);
  const set = (scene.__set ??= setter(scene));
  // The screens load with the room.
  scene.querySelectorAll('.ph-phone img:not([src])').forEach((img) => (img.src = img.dataset.src));

  set('--in', ease(span(p, 0, 0.12)));
  set('--up', ease(span(p, 0.02, 0.22)));
  set('--drift', clamp(p));
  let last = 0;
  scene.querySelectorAll('.ph-card').forEach((card) => {
    const k = +card.style.getPropertyValue('--k');
    const s = 0.12 + k * 0.16;
    const out = spring(span(p, s, s + 0.1));
    // Pressed in, let go, then the tick pops.
    const press = span(p, s + 0.11, s + 0.13) * (1 - span(p, s + 0.13, s + 0.16));
    const done = spring(span(p, s + 0.13, s + 0.2));
    card.style.setProperty('--a', out.toFixed(3));
    card.style.setProperty('--press', press.toFixed(3));
    card.style.setProperty('--done', done.toFixed(3));
    if (p >= s + 0.13) last = Math.max(last, k);
  });
  const showing = SHOWS[last];
  scene
    .querySelectorAll('.ph-phone img')
    .forEach((img, k) => img.classList.toggle('on', k === showing));
  set('--scan', showing === 0 ? span(p, 0.25, 0.36) : 0);
}
