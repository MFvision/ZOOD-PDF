// The desk: A4 pages (1 : 1.414) drawn as HTML and inline SVG. Body text is
// rounded bars; the top page's Arabic is outlines (desk-arabic.js), so it looks
// the same before any font loads. Every motion is a CSS custom property the
// scroll loop in main.js writes; the rules are in css/site.css.
import { ARABIC_LINES } from './desk-arabic.js';

const W = 2100;
const H = 2970;
const RIGHT = 1880;
const LEFT = 220;
const NS = 'http://www.w3.org/2000/svg';

// A small seeded random, so the pages look the same on every visit.
function random(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function bars(rand, top, lines, { indent = 0, height = 30, step = 92, width = RIGHT - LEFT } = {}) {
  let out = '';
  for (let l = 0; l < lines; l++) {
    const last = l === lines - 1;
    const lineWidth = last ? width * (0.35 + rand() * 0.3) : width - (l === 0 ? indent : 0);
    let x = RIGHT - (l === 0 ? indent : 0);
    const end = RIGHT - (l === 0 ? indent : 0) - lineWidth;
    while (x > end + 40) {
      const w = Math.min(x - end, 90 + rand() * 230);
      out += `<rect class="bar" x="${(x - w).toFixed(0)}" y="${top + l * step}" width="${w.toFixed(0)}" height="${height}" rx="${height / 2}"/>`;
      x -= w + 34;
    }
  }
  return out;
}

// A plain page of bars: a heading, then paragraphs.
function plainPage(seed) {
  const rand = random(seed);
  let svg = `<rect class="bar" x="${RIGHT - 900}" y="330" width="900" height="70" rx="35" opacity=".9"/>`;
  svg += `<rect class="rule" x="${LEFT}" y="470" width="${RIGHT - LEFT}" height="5"/>`;
  let y = 620;
  for (let p = 0; p < 5; p++) {
    const lines = 3 + Math.floor(rand() * 3);
    svg += bars(rand, y, lines, { indent: p ? 120 : 0 });
    y += lines * 92 + 110;
  }
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">${svg}</svg>`;
}

// The reflow paragraph: the same words laid out before and after a new word is
// typed in, so each bar can move from one place to the other.
function reflowParagraph(top) {
  const rand = random(7);
  const words = Array.from({ length: 22 }, () => 120 + Math.round(rand() * 200));
  const inserted = 3;
  const layout = (extra) => {
    const out = [];
    let x = RIGHT;
    let line = 0;
    words.forEach((w0, i) => {
      const w = i === inserted ? extra : w0;
      if (x - w < LEFT) {
        line++;
        x = RIGHT;
      }
      out.push({ x: x - w, y: top + line * 92, w });
      x -= w + (w ? 34 : 0);
    });
    return out;
  };
  words.splice(inserted, 0, 0);
  const before = layout(0);
  const after = layout(300);
  return before
    .map((b, i) => {
      const a = after[i];
      if (i === inserted) {
        // Drawn at its full width, then scaled from nothing as it is typed.
        return `<rect class="reflow-new" x="${b.x - 300}" y="${b.y}" width="300" height="30" rx="15" style="--dx:${a.x - (b.x - 300)};--dy:${a.y - b.y}"/>`;
      }
      return `<rect class="reflow-bar" x="${b.x}" y="${b.y}" width="${b.w}" height="30" rx="15" style="--dx:${a.x - b.x};--dy:${a.y - b.y}"/>`;
    })
    .join('');
}

// The top page: Arabic lines that write in, the search band, a paragraph that
// reflows, markup, a signature and stamp, and redaction bars.
function arabicPage() {
  let svg = '';
  let covers = '';
  let find = '';
  const rows = [];
  let y = 420;
  ARABIC_LINES.forEach((line, n) => {
    const x = RIGHT - line.w;
    rows.push({ x, y, w: line.w, size: line.size });
    svg += `<path class="ink" transform="translate(${x.toFixed(1)} ${y})" d="${line.d}"/>`;
    covers += `<rect class="cover" x="${(x - 14).toFixed(0)}" y="${(y - line.size * 1.15).toFixed(0)}" width="${(line.w + 28).toFixed(0)}" height="${(line.size * 1.75).toFixed(0)}" style="--n:${n}"/>`;
    if (line.word && n === 1) {
      const [lo, hi] = line.word;
      find = `<rect class="find-band" x="${(x + lo - 8).toFixed(0)}" y="${(y - line.size * 1.05).toFixed(0)}" width="${(hi - lo + 16).toFixed(0)}" height="${(line.size * 1.6).toFixed(0)}" rx="10"/>`;
    }
    y += n === 0 ? 230 : 150;
    if (n === 0)
      svg += `<rect class="rule" x="${LEFT}" y="${y - 120}" width="${RIGHT - LEFT}" height="5"/>`;
  });
  const para = reflowParagraph(y + 80);

  // Markup: a highlight on the second body line, a sticky note, an ink ring around the amount.
  const hlRow = rows[2];
  const mark = `<rect class="mark-hl" x="${(hlRow.x - 10).toFixed(0)}" y="${(hlRow.y - hlRow.size).toFixed(0)}" width="${(hlRow.w + 20).toFixed(0)}" height="${(hlRow.size * 1.45).toFixed(0)}" rx="8"/>
    <g class="mark-note"><rect x="170" y="150" width="440" height="400" rx="10" fill="#f3e3c7" stroke="#c9a27c" stroke-width="4"/>
      <rect x="230" y="250" width="320" height="26" rx="13" fill="#c9a27c"/><rect x="290" y="320" width="260" height="26" rx="13" fill="#c9a27c"/><rect x="350" y="390" width="200" height="26" rx="13" fill="#c9a27c"/></g>`;
  const amount = rows[3];
  const ink = `<g class="mark-ink"><path d="M ${RIGHT - 30} ${amount.y - 120} C ${RIGHT + 40} ${amount.y + 10}, ${RIGHT - 560} ${amount.y + 70}, ${RIGHT - 640} ${amount.y - 20} S ${RIGHT - 300} ${amount.y - 170}, ${RIGHT - 60} ${amount.y - 100}" fill="none" stroke="#2f6fb5" stroke-width="12" stroke-linecap="round"/>
    <rect class="mark-ink-cover" x="${RIGHT - 700}" y="${amount.y - 190}" width="780" height="300"/></g>`;

  // Redaction: navy bars over the amount, the IBAN line and the last line.
  const redact = [3, 4, 5]
    .map((r, n) => {
      const row = rows[r];
      return `<rect class="redact-bar" x="${(row.x - 12).toFixed(0)}" y="${(row.y - row.size * 1.05).toFixed(0)}" width="${(row.w + 24).toFixed(0)}" height="${(row.size * 1.5).toFixed(0)}" rx="4" style="--n:${n}"/>`;
    })
    .join('');

  // Signature and stamp.
  const sy = 2560;
  const sign = `<g class="sign-line"><rect x="${RIGHT - 760}" y="${sy}" width="760" height="5" fill="#041e42" opacity=".5"/>
    <path d="M ${RIGHT - 60} ${sy - 60} C ${RIGHT - 140} ${sy - 230}, ${RIGHT - 230} ${sy - 10}, ${RIGHT - 300} ${sy - 110} S ${RIGHT - 420} ${sy - 190}, ${RIGHT - 470} ${sy - 70} S ${RIGHT - 600} ${sy - 40}, ${RIGHT - 700} ${sy - 150}" fill="none" stroke="#041e42" stroke-width="11" stroke-linecap="round"/>
    <rect class="sign-cover" x="${RIGHT - 740}" y="${sy - 260}" width="740" height="250"/></g>
    <g class="sign-stamp"><circle cx="560" cy="${sy - 120}" r="190" fill="none" stroke="#977756" stroke-width="12"/><circle cx="560" cy="${sy - 120}" r="150" fill="none" stroke="#977756" stroke-width="4"/>
    <rect x="440" y="${sy - 150}" width="240" height="26" rx="13" fill="#977756"/><rect x="480" y="${sy - 100}" width="160" height="22" rx="11" fill="#977756"/></g>`;

  const front = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">${find}${mark}${svg}${covers}${para}${ink}${redact}${sign}</svg>`;

  // The scan: the same page as grey, slightly smudged bars.
  const rand = random(3);
  let grey = '';
  rows.forEach((row, n) => {
    grey += `<rect class="bar" x="${(row.x + rand() * 30).toFixed(0)}" y="${(row.y - row.size * 0.7).toFixed(0)}" width="${row.w.toFixed(0)}" height="${(row.size * (n ? 0.75 : 0.95)).toFixed(0)}" rx="12" opacity="${(0.55 + rand() * 0.3).toFixed(2)}"/>`;
  });
  grey += bars(rand, y + 80, 5).replace(/class="bar"/g, 'class="bar" opacity=".55"');
  const scan = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">${grey}</svg>`;
  return { front, scan };
}

export function buildStage(sample) {
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.setAttribute('aria-hidden', 'true');
  const top = arabicPage();
  const sheets = [
    `<div class="sheet top" style="--i:0"><div class="leaf"><div class="leaf-front">${top.front}</div><div class="sheet-back"></div></div><div class="scan-sheet">${top.scan}</div></div>`,
    `<div class="sheet" style="--i:1;--ord:1;--jr:-1.6deg">${plainPage(11)}</div>`,
    `<div class="sheet" style="--i:2;--ord:1;--jr:1.4deg">${plainPage(23)}</div>`,
    `<div class="sheet" style="--i:3;--ord:-2;--lift:1;--jr:-0.8deg">${plainPage(37)}</div>`,
    `<div class="sheet" style="--i:4;--jr:2deg">${plainPage(51)}</div>`,
  ];
  stage.innerHTML = `<div class="desk-dusk"></div><div class="desk-pattern"></div>
    <div class="desk"><div class="desk-move"><div class="frame"></div>${sheets.join('')}
      <div class="prop prop-search">${sample.search}</div>
      <div class="prop prop-size">${sample.sizes.before} → <span class="after">${sample.sizes.after}</span></div>
    </div></div>`;
  return stage;
}

// Device frames (generic, no maker's marks): the SVG bezel with a screen-shaped hole.
export function phoneFrame() {
  return `<svg viewBox="0 0 100 207.2" aria-hidden="true" focusable="false"><path fill-rule="evenodd" fill="#0d1726" d="M14 0h72a14 14 0 0 1 14 14v179.2a14 14 0 0 1-14 14H14a14 14 0 0 1-14-14V14A14 14 0 0 1 14 0ZM14 4a10 10 0 0 0-10 10v179.2a10 10 0 0 0 10 10h72a10 10 0 0 0 10-10V14a10 10 0 0 0-10-10Z"/><rect x="40" y="7.5" width="20" height="5" rx="2.5" fill="#0d1726"/><path fill="none" stroke="#3b4a60" stroke-width=".5" d="M14 .4h72A13.6 13.6 0 0 1 99.6 14v179.2a13.6 13.6 0 0 1-13.6 13.6H14A13.6 13.6 0 0 1 .4 193.2V14A13.6 13.6 0 0 1 14 .4Z"/></svg>`;
}

export function tabletFrame() {
  return `<svg viewBox="0 0 106 81" aria-hidden="true" focusable="false"><path fill-rule="evenodd" fill="#0d1726" d="M5 0h96a5 5 0 0 1 5 5v71a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5ZM4.5 3A1.5 1.5 0 0 0 3 4.5v72A1.5 1.5 0 0 0 4.5 78h97a1.5 1.5 0 0 0 1.5-1.5v-72A1.5 1.5 0 0 0 101.5 3Z"/><path fill="none" stroke="#3b4a60" stroke-width=".3" d="M5 .2h96a4.8 4.8 0 0 1 4.8 4.8v71a4.8 4.8 0 0 1-4.8 4.8H5A4.8 4.8 0 0 1 .2 76V5A4.8 4.8 0 0 1 5 .2Z"/></svg>`;
}
