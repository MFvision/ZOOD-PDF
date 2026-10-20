// The family room: every version of the app together, as the concept the app
// was designed from showed it. The computer comes up first with the assistant
// floating beside it, then the iPad, the iPhone and Windows rise under it;
// the pen writes on the iPad and the phone scans its page. Every screen is
// the app's own (tools/capture-screens.mjs); the pen, the assistant card and
// the scan line are drawn.
import { clamp, ease, setter, span, spring, stepped } from './motion.js';

const WORDS = {
  assistant: { ar: 'المساعد الذكي', en: 'AI assistant' },
  ask: { ar: 'اسأل عن هذا الملف…', en: 'Ask about this file…' },
  chips: {
    ar: ['لخّص هذا الملف', 'اشرحه ببساطة', 'ترجمه إلى الإنجليزية'],
    en: ['Summarize this file', 'Explain it simply', 'Translate it to Arabic'],
  },
  mac: { ar: 'ماك', en: 'Mac' },
  macLine: { ar: 'حرّر الفقرة العربية كما تُكتب.', en: 'Edit an Arabic paragraph in place.' },
  ipad: { ar: 'آيباد', en: 'iPad' },
  ipadLine: {
    ar: 'اكتب بالقلم، وظلّل بإصبعك.',
    en: 'Write with the pen, highlight with a finger.',
  },
  iphone: { ar: 'آيفون', en: 'iPhone' },
  iphoneLine: {
    ar: 'صوّر الورقة، فتصير ملفًا تبحث فيه.',
    en: 'Photograph a page into a searchable file.',
  },
  windows: { ar: 'ويندوز', en: 'Windows' },
  windowsLine: { ar: 'رتّب الصفحات بسحبها.', en: 'Reorder pages by dragging them.' },
};

const spark =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5 4.6-.6 6.9-2.9 7.5-7.5Z"/></svg>';
// The pen: a slim barrel with a bronze tip, drawn pointing down-left.
const pen =
  '<svg viewBox="0 0 20 120" aria-hidden="true"><defs><linearGradient id="fam-pen" x1="0" x2="1"><stop offset="0" stop-color="#e9e4de"/><stop offset=".55" stop-color="#ffffff"/><stop offset="1" stop-color="#cfc8c0"/></linearGradient></defs><path d="M4 8a6 6 0 0 1 12 0v92H4Z" fill="url(#fam-pen)"/><path d="M4 100h12l-6 18Z" fill="#d6c6b8"/><path d="M8.6 114h2.8L10 118.5Z" fill="#977756"/></svg>';

export function familyScene(t, escape, media, frames) {
  const shot = (device, name, clip) => {
    const [w, h] = media.size(device);
    const img = `<img alt="" width="${w}" height="${h}" decoding="async" data-screen="${device} ${name}" data-src="${escape(media.still(device, name))}">`;
    const video = clip
      ? `<video muted loop playsinline disablepictureinpicture preload="none" width="${w}" height="${h}" data-screen="${device} ${name}" data-src="${escape(media.clip(device, name))}"></video>`
      : '';
    return `<div class="screen">${img}${video}</div>`;
  };
  const caption = (name, line) =>
    `<p class="fam-cap"><b>${escape(t(WORDS[name]))}</b><span>${escape(t(WORDS[line]))}</span></p>`;
  const chips = t(WORDS.chips)
    .map((c, k) => `<li style="--k:${k}"><span>${spark}</span>${escape(t(c))}</li>`)
    .join('');
  return `<div class="fam glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="fam-main fam-unit" style="--u:0"><div class="fam-win"><div class="win-strip"></div>${shot('desktop', 'edit', true)}</div>${caption('mac', 'macLine')}</div>
    <div class="fam-ai glass"><p class="fam-ai-head"><span>${spark}</span>${escape(t(WORDS.assistant))}</p><ul>${chips}</ul><p class="fam-ai-ask">${escape(t(WORDS.ask))}</p></div>
    <div class="fam-ipad fam-unit" style="--u:1"><div class="fam-tablet">${shot('tablet', 'comment', true)}${frames.tablet}
      <div class="fam-draw"><svg class="fam-ink" viewBox="0 0 100 75"><path pathLength="1" d="M20 52c8-3 16-4 24-2s14 3 20 0 10-6 14-4"/></svg><div class="fam-pen">${pen}</div></div></div>${caption('ipad', 'ipadLine')}</div>
    <div class="fam-iphone fam-unit" style="--u:2"><div class="fam-phone">${shot('phone', 'scan')}<div class="ph-scanline"></div>${frames.phone}</div>${caption('iphone', 'iphoneLine')}</div>
    <div class="fam-windows fam-unit" style="--u:3"><div class="fam-win"><div class="win-strip"></div>${shot('desktop', 'pages', true)}</div>${caption('windows', 'windowsLine')}</div>
  </div>`;
}

export function familyFrame(el, p, reduced) {
  const scene = el.querySelector('.fam');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.1, 0.92]);
  const set = (scene.__set ??= setter(scene));
  set('--drift', clamp(p));
  // The computer first, then the three below it, each landing with a bounce.
  scene.querySelectorAll('.fam-unit').forEach((unit, k) => {
    const s = k === 0 ? 0 : 0.2 + (k - 1) * 0.08;
    unit.style.setProperty('--a', spring(span(p, s, s + 0.16)).toFixed(3));
  });
  // The assistant floats in and offers what it can do, one line after another.
  set('--ai', spring(span(p, 0.1, 0.24)));
  scene.querySelectorAll('.fam-ai li').forEach((li, k) => {
    li.style.setProperty('--a', spring(span(p, 0.16 + k * 0.04, 0.26 + k * 0.04)).toFixed(3));
  });
  // The pen writes, and the phone scans.
  const ink = ease(span(p, 0.5, 0.72));
  set('--ink', ink);
  set('--pen', clamp(span(p, 0.44, 0.5) - span(p, 0.74, 0.8)));
  const path = scene.querySelector('.fam-ink path');
  if (path.getTotalLength) {
    // The pen's tip follows the end of the line, in the tablet's own units.
    // In Arabic the line is drawn mirrored, right to left.
    const at = path.getPointAtLength(ink * path.getTotalLength());
    const x = document.documentElement.dir === 'rtl' ? 100 - at.x : at.x;
    set('--pen-x', `${x.toFixed(2)}%`);
    set('--pen-y', `${((at.y / 75) * 100).toFixed(2)}%`);
  }
  set('--scan', span(p, 0.5, 0.66));
  // Screens load with the room; recordings play while it is on screen.
  const on = p > 0 && p < 1 && !reduced;
  scene.querySelectorAll('img:not([src])').forEach((img) => (img.src = img.dataset.src));
  scene.querySelectorAll('video').forEach((v) => {
    if (on && v.dataset.src) {
      if (!v.getAttribute('src')) {
        v.setAttribute('src', v.dataset.src);
        v.addEventListener('playing', () => v.classList.add('on'), { once: true });
      }
      if (v.paused) v.play().catch(() => {});
    } else if (!v.paused) v.pause();
  });
}
