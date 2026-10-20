// The remote room: the computer shows a code, a phone scans it, and the phone
// becomes the remote, one ability per scroll step. First it presents (pages
// turn, a laser points, the pen writes), then it is a trackpad and keyboard,
// then files and a signature travel between the two. A drawing of the
// desktop app's phone remote, not a recording.
import { clamp, ease, mix, setter, span, spring, stepped } from './motion.js';

const WORDS = {
  steps: {
    ar: ['اعرض من هاتفك', 'لوحة لمس ومفاتيح', 'ملفات بين الجهازين'],
    en: ['Present', 'Trackpad and keys', 'Files both ways'],
  },
  connected: { ar: 'متصل', en: 'Connected' },
  slide: { ar: 'خطة الربع القادم', en: 'Next quarter plan' },
  notes: { ar: 'ملاحظاتك', en: 'Your notes' },
  typed: { ar: 'مرحبًا', en: 'Hello' },
  toPhone: { ar: 'إلى الهاتف', en: 'To phone' },
  photo: { ar: 'صورة صفحة', en: 'Page photo' },
  sign: { ar: 'وقّع هنا', en: 'Sign here' },
};

const pdf =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const camera =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const check =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const cursor =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2.5 19 13l-6.2 1.2L9.4 20.5Z" fill="#fdfcfa" stroke="#041e42" stroke-width="1.6" stroke-linejoin="round"/></svg>';
// A made-up code: a fixed pattern of squares, not a real link.
const qr = (() => {
  let cells = '';
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++)
      if ((x * 7 + y * 5 + x * y) % 3 === 0)
        cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  const eye = (x, y) =>
    `<path d="M${x} ${y}h3v3h-3Z M${x + 0.6} ${y + 0.6}v1.8h1.8v-1.8Z" fill-rule="evenodd"/>`;
  return `<svg viewBox="-1 -1 11 11" aria-hidden="true"><g fill="#041e42">${cells}${eye(0, 0)}${eye(6, 0)}${eye(0, 6)}</g></svg>`;
})();
// The signature, written once on the phone and again on the page.
const sig = (cls) =>
  `<svg class="${cls}" viewBox="0 0 100 40" aria-hidden="true"><path pathLength="1" d="M6 28c6-14 12-20 15-14s-6 16-2 14 9-16 13-12-2 12 2 10 8-10 12-8 0 8 4 7 10-6 14-6 8 4 14 2 10-6 14-8"/></svg>`;

export function remoteScene(t, escape, frame) {
  const steps = t(WORDS.steps)
    .map((s, k) => `<li style="--k:${k}"><b>${k + 1}</b>${escape(s)}</li>`)
    .join('');
  const thumbs = [1, 2, 3, 4].map((n) => `<i class="t${n}"></i>`).join('');
  return `<div class="rm glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <ol class="rm-steps glass">${steps}</ol>
    <div class="rm-desk"><div class="win-strip"></div><div class="rm-screen">
      <div class="rm-slide"><p class="rm-title">${escape(t(WORDS.slide))}</p><div class="lib-bars"><i></i><i></i><i></i></div>
        <svg class="rm-ink" viewBox="0 0 100 60" aria-hidden="true"><path pathLength="1" d="M18 44c10 4 22 5 34 2s20-6 28-4"/></svg>
        <span class="rm-page"><span class="rm-pn"><b class="p3">3</b><b class="p4">4</b></span> / 12</span>
        <span class="rm-field">${escape(t(WORDS.typed)).replace(/./gu, (c) => `<i>${c}</i>`)}<u></u></span>
        ${sig('rm-sig-page')}
      </div>
      <span class="rm-laser"></span>
      <span class="rm-cursor">${cursor}</span>
      <div class="rm-qr">${qr}</div>
    </div></div>
    <div class="rm-phone"><div class="rm-pscreen">
      <div class="rm-panel rm-present"><div class="rm-strip">${thumbs}</div><div class="rm-big"><span>‹</span><span>›</span></div><p class="rm-notes"><b>${escape(t(WORDS.notes))}</b><i></i><i></i></p><p class="rm-timer">02:14</p></div>
      <div class="rm-panel rm-pad"><span class="rm-finger"></span><div class="rm-keys">${'<i></i>'.repeat(30)}</div></div>
      <div class="rm-panel rm-files"><span class="rm-btn">${pdf}${escape(t(WORDS.toPhone))}</span><span class="rm-btn">${camera}${escape(t(WORDS.photo))}</span><div class="rm-signbox"><small>${escape(t(WORDS.sign))}</small>${sig('rm-sig-phone')}</div></div>
      <div class="rm-link"><span>${check}</span>${escape(t(WORDS.connected))}</div>
    </div>${frame}</div>
    <div class="rm-fly glass"><span class="rm-fly-pdf">${pdf}</span><span class="rm-fly-cam">${camera}</span></div>
  </div>`;
}

export function remoteFrame(el, p, reduced) {
  const scene = el.querySelector('.rm');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.12, 0.34, 0.62, 0.95]);
  const set = (scene.__set ??= setter(scene));
  set('--drift', clamp(p));
  set('--in', ease(span(p, 0, 0.06)));
  // Pairing: the code on the computer, the phone comes in, a tick.
  set('--phone', spring(span(p, 0.02, 0.1)));
  set('--qr', 1 - ease(span(p, 0.1, 0.14)));
  set('--link', spring(span(p, 0.09, 0.14)) * (1 - span(p, 0.2, 0.24)));
  const step = p < 0.41 ? 0 : p < 0.69 ? 1 : 2;
  scene.dataset.step = step;
  scene
    .querySelectorAll('.rm-steps li')
    .forEach((li, k) => li.classList.toggle('on', k === step && p > 0.12));
  el.querySelectorAll('.ring-words .points li').forEach((li, k) =>
    li.classList.toggle('now', k === step),
  );

  // 1. Present: the page turns, the laser points, the pen writes.
  const turn = ease(span(p, 0.17, 0.21));
  set('--turn', turn);
  set('--flip', Math.sin(turn * Math.PI));
  const laser = span(p, 0.23, 0.3);
  set('--laser', clamp(span(p, 0.22, 0.24) - span(p, 0.3, 0.32)));
  set('--lx', `${mix(30, 66, ease(laser)).toFixed(1)}%`);
  set('--ly', `${(40 + Math.sin(laser * Math.PI) * 14).toFixed(1)}%`);
  set('--ink', ease(span(p, 0.31, 0.38)));
  set('--inkfade', 1 - span(p, 0.41, 0.44));
  // 2. Trackpad and keys: a finger moves, the pointer follows, a tap, typing.
  const move = ease(span(p, 0.44, 0.53));
  set('--fx', `${mix(62, 30, move).toFixed(1)}%`);
  set('--fy', `${mix(62, 34, move).toFixed(1)}%`);
  set('--cx', `${mix(72, 34, move).toFixed(1)}%`);
  set('--cy', `${mix(70, 62, move).toFixed(1)}%`);
  set('--cursor', clamp(span(p, 0.42, 0.44) - span(p, 0.68, 0.7)));
  set('--tap', span(p, 0.54, 0.6));
  set('--kb', spring(span(p, 0.57, 0.62)));
  const letters = scene.querySelectorAll('.rm-field i');
  const typed = Math.round(letters.length * span(p, 0.6, 0.67));
  letters.forEach((c, k) => c.classList.toggle('on', k < typed));
  set('--field', ease(span(p, 0.55, 0.58)) * (1 - span(p, 0.69, 0.71)));
  // 3. Files: the PDF flies to the phone, a photo comes back as a PDF, a signature lands.
  const out = span(p, 0.72, 0.79);
  const back = span(p, 0.81, 0.88);
  const going = p < 0.8;
  set('--fly', going ? ease(out) : 1 - ease(back));
  set('--flyon', going ? Math.sin(out * Math.PI) : Math.sin(back * Math.PI));
  scene.classList.toggle('rm-back', !going);
  set('--sigp', ease(span(p, 0.88, 0.93)));
  set('--sigd', ease(span(p, 0.93, 0.98)));
}
