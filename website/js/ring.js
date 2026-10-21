// The ring chapter: a folder, two files dragged out of it with Ctrl held, the
// app's ring of tools opening under the pointer, the files let go on
// Compress, the progress going round, and the smaller copies landing beside
// the originals. Drawn after the app's own ring (packages/ui/src/quick:
// Ring.tsx, ringGeometry.ts, plan.ts), played by the scroll.
import { ICONS } from './ring-icons.js';

const SIZE = 300;
const OUTER = 140;
const INNER = 54;
const BAND = (OUTER + INNER) / 2;
const CIRC = 2 * Math.PI * BAND;

// The ring's tools for PDFs, in the app's order. The app names three of them
// after their programs; here they go by the files they make.
const TOOLS = [
  ['compress', { ar: 'ضغط', en: 'Compress' }],
  ['word', { ar: 'docx', en: 'docx' }],
  ['excel', { ar: 'xlsx', en: 'xlsx' }],
  ['powerpoint', { ar: 'pptx', en: 'pptx' }],
  ['ocr', { ar: 'OCR', en: 'OCR' }],
  ['combine', { ar: 'دمج', en: 'Combine' }],
  ['rotate', { ar: 'تدوير', en: 'Rotate' }],
  ['split', { ar: 'تقسيم', en: 'Split' }],
  ['sign', { ar: 'توقيع', en: 'Sign' }],
  ['protect', { ar: 'حماية', en: 'Protect' }],
  ['all', { ar: 'كل الأدوات', en: 'All tools' }],
];

const WORDS = {
  folder: { ar: 'التقارير', en: 'Reports' },
  files: {
    ar: ['تقرير-الربع.pdf', 'العقد.pdf', 'الفاتورة.pdf', 'المحضر.pdf'],
    en: ['quarter-report.pdf', 'contract.pdf', 'invoice.pdf', 'minutes.pdf'],
  },
  smaller: { ar: '-مضغوط', en: '-compressed' },
  drop: { ar: 'أفلت للاختيار', en: 'Drop to choose' },
  done: { ar: 'تم', en: 'Done' },
};

const fixed = (n) => Number(n.toFixed(2));
const at = (angle, r) => ({ x: SIZE / 2 + r * Math.sin(angle), y: SIZE / 2 - r * Math.cos(angle) });

function segments(count) {
  const step = (2 * Math.PI) / count;
  return Array.from({ length: count }, (_, i) => {
    const s = i * step - step / 2 + 0.02;
    const e = i * step + step / 2 - 0.02;
    const [a, b, c, d] = [at(s, OUTER), at(e, OUTER), at(e, INNER), at(s, INNER)];
    const path = `M${fixed(a.x)} ${fixed(a.y)}A${OUTER} ${OUTER} 0 0 1 ${fixed(b.x)} ${fixed(b.y)}L${fixed(c.x)} ${fixed(c.y)}A${INNER} ${INNER} 0 0 0 ${fixed(d.x)} ${fixed(d.y)}Z`;
    const label = at(i * step, BAND);
    return { path, label: { x: fixed(label.x), y: fixed(label.y) } };
  });
}

const fileIcon = `<svg class="rs-pdf" viewBox="0 0 40 50" aria-hidden="true"><path d="M4 0h22l14 14v32a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4Z" fill="var(--rs-file)"/><path d="M26 0v10a4 4 0 0 0 4 4h10Z" fill="var(--rs-fold)"/><rect x="5" y="30" width="30" height="12" rx="2.5" fill="#b4232a"/><text x="20" y="39.4" text-anchor="middle">PDF</text></svg>`;

/** The scene's markup; `t` picks the page's language. */
export function ringScene(t, escape) {
  const segs = segments(TOOLS.length);
  const ring = segs
    .map((s, i) => {
      const [id, name] = TOOLS[i];
      return `<g class="rs-seg${i === 0 ? ' rs-target' : ''}"><path d="${s.path}"/><svg x="${s.label.x - 11}" y="${s.label.y - 20}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[id]}</svg><text x="${s.label.x}" y="${s.label.y + 16}" text-anchor="middle">${escape(t(name))}</text></g>`;
    })
    .join('');
  const names = t(WORDS.files);
  const tile = (name, cls) =>
    `<div class="rs-file ${cls}">${fileIcon}<span dir="ltr">${escape(name)}</span></div>`;
  const smaller = (name) => name.replace(/\.pdf$/, `${t(WORDS.smaller)}.pdf`);
  return `<div class="rs" aria-hidden="true">
    <div class="rs-window">
      <div class="rs-bar"><span class="rs-folder"></span>${escape(t(WORDS.folder))}</div>
      <div class="rs-grid">
        ${tile(names[0], 'rs-a')}${tile(names[1], 'rs-b')}${tile(names[2], '')}${tile(names[3], '')}
        ${tile(smaller(names[0]), 'rs-new')}${tile(smaller(names[1]), 'rs-new')}
      </div>
    </div>
    <div class="rs-ghost">${fileIcon}${fileIcon}<b>2</b></div>
    <div class="rs-ring"><div class="rs-glass"></div><svg viewBox="0 0 ${SIZE} ${SIZE}">
      <defs>
        <linearGradient id="rs-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity=".82"/>
          <stop offset=".45" stop-color="#fff" stop-opacity=".46"/>
          <stop offset="1" stop-color="#fff" stop-opacity=".66"/>
        </linearGradient>
        <linearGradient id="rs-rim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity=".95"/>
          <stop offset=".5" stop-color="#fff" stop-opacity=".15"/>
          <stop offset="1" stop-color="#fff" stop-opacity=".7"/>
        </linearGradient>
        <linearGradient id="rs-bronze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c9a27c" stop-opacity=".95"/>
          <stop offset="1" stop-color="#8a6a4b" stop-opacity=".9"/>
        </linearGradient>
        <filter id="rs-liquid" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency=".018" numOctaves="2" seed="7"/>
          <feDisplacementMap in="SourceGraphic" scale="0" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
      <g class="rs-zoom">
      <circle class="rs-shadow" cx="150" cy="150" r="${OUTER + 4}"/>${ring}
      <circle class="rs-rim" cx="150" cy="150" r="${OUTER - 0.5}"/>
      <circle class="rs-track" cx="150" cy="150" r="${BAND}"/>
      <circle class="rs-bar-p" cx="150" cy="150" r="${BAND}" transform="rotate(-90 150 150)" stroke-dasharray="0 ${CIRC}"/>
      <circle class="rs-hub" cx="150" cy="150" r="${INNER - 4}"/><circle class="rs-rim" cx="150" cy="150" r="${INNER - 4.5}"/>
      <text class="rs-hub-text" x="150" y="155" text-anchor="middle" data-drop="${escape(t(WORDS.drop))}" data-done="${escape(t(WORDS.done))}">${escape(t(WORDS.drop))}</text>
      <svg class="rs-tick" x="132" y="104" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS.check}</svg>
    </g></svg></div>
    <div class="rs-key" dir="ltr">Ctrl</div>
    <div class="rs-pointer"><svg viewBox="0 0 24 24"><path d="M5 2.5 19 13l-6.2 1.2L9.4 20.5Z" fill="#fdfcfa" stroke="#041e42" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
  </div>`;
}

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (p, s, e) => clamp((p - s) / (e - s));
const ease = (x) => 1 - (1 - x) ** 3;
const mix = (a, b, k) => a + (b - a) * k;

// Points in the scene, as fractions of its width and height.
const REST = [0.9, 0.92];
const RING = [0.62, 0.52];

/** Draws the scene at p (0-1 through the chapter); reduced steps through it. */
export function ringFrame(el, p, reduced) {
  if (reduced) p = [0.05, 0.3, 0.4, 0.6, 0.76, 0.95].find((s) => p <= s + 0.08) ?? 0.95;
  const scene = el.querySelector('.rs');
  if (!scene) return;
  const key = p.toFixed(3);
  if (scene.dataset.p === key) return;
  scene.dataset.p = key;

  // The first file's middle, wherever the layout put it.
  const box = scene.getBoundingClientRect();
  const a = scene.querySelector('.rs-a .rs-pdf').getBoundingClientRect();
  const FILE = [
    (a.left + a.width / 2 - box.left) / box.width,
    (a.top + a.height / 2 - box.top) / box.height,
  ];
  const ringW = scene.querySelector('.rs-ring').offsetWidth / scene.offsetWidth;
  const ringH = ringW * (scene.offsetWidth / scene.offsetHeight);
  // The Compress segment's middle, the top of the ring.
  const TARGET = [RING[0], RING[1] - ringH * (BAND / SIZE)];

  let x;
  let y;
  if (p < 0.1) {
    const k = ease(span(p, 0, 0.1));
    [x, y] = [mix(REST[0], FILE[0], k), mix(REST[1], FILE[1], k)];
  } else if (p < 0.32) {
    const k = ease(span(p, 0.16, 0.32));
    [x, y] = [mix(FILE[0], RING[0], k), mix(FILE[1], RING[1], k)];
  } else if (p < 0.8) {
    const k = ease(span(p, 0.32, 0.42));
    [x, y] = [mix(RING[0], TARGET[0], k), mix(RING[1], TARGET[1], k)];
  } else {
    const k = ease(span(p, 0.8, 0.95));
    [x, y] = [mix(TARGET[0], REST[0], k), mix(TARGET[1], REST[1], k)];
  }
  const set = (name, v) => scene.style.setProperty(name, typeof v === 'number' ? v.toFixed(3) : v);
  set('--px', x);
  set('--py', y);
  set('--pick', p >= 0.1 ? 1 : 0);
  const dragging = p >= 0.16 && p < 0.43;
  set('--drag', dragging ? 1 : 0);
  set('--key', p >= 0.14 && p < 0.43 ? 1 : 0);
  const ringin = ease(span(p, 0.24, 0.32)) * (1 - span(p, 0.8, 0.86));
  set('--ringin', ringin);
  // Scaled inside the drawing: a CSS scale on the box left the labels behind in Chromium.
  const z = 0.6 + ringin * 0.4;
  const zoom = scene.querySelector('.rs-zoom');
  zoom.setAttribute(
    'transform',
    `translate(${150 * (1 - z)} ${150 * (1 - z)}) scale(${z.toFixed(3)})`,
  );
  // Liquid: the ring wobbles into shape as it opens, then holds still and sharp.
  const wobble = reduced ? 0 : (1 - ringin) * 34;
  scene.querySelector('#rs-liquid feDisplacementMap').setAttribute('scale', wobble.toFixed(1));
  if (wobble > 0.5) zoom.setAttribute('filter', 'url(#rs-liquid)');
  else zoom.removeAttribute('filter');
  const over = p >= 0.38 && p < 0.8;
  set('--over', over ? 1 : 0);
  scene.classList.toggle('rs-over', over);
  const run = span(p, 0.44, 0.68);
  set('--run', p >= 0.44 ? 1 : 0);
  set('--done', p >= 0.7 ? 1 : 0);
  set('--landed', ease(span(p, 0.84, 0.94)));
  scene
    .querySelector('.rs-bar-p')
    .setAttribute('stroke-dasharray', `${(CIRC * run).toFixed(1)} ${CIRC.toFixed(1)}`);
  const hub = scene.querySelector('.rs-hub-text');
  const text =
    p >= 0.7 ? hub.dataset.done : p >= 0.44 ? `${Math.round(run * 100)}%` : hub.dataset.drop;
  if (hub.textContent !== text) hub.textContent = text;
  hub.setAttribute('y', p >= 0.7 ? '166' : '155');
}
