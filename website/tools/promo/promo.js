// The 30-second film of the app, drawn frame by frame: window.render(t) puts
// the stage at time t (seconds), and tools/promo/make.mjs captures 30 frames a
// second, adds the music (music.mjs) and encodes it. Every screen inside the
// devices is the app's own (tools/capture-screens.mjs); the devices, the pen,
// the fingers and the words are drawn here.
import { phoneFrame, tabletFrame } from '../../js/desk.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'ar';
const rtl = lang === 'ar';
document.documentElement.lang = lang;
document.documentElement.dir = rtl ? 'rtl' : 'ltr';
const t = (w) => (typeof w === 'string' ? w : w[lang]);

export const LENGTH = 30;
export const FPS = 30;

// The clips, as frames make.mjs extracts at 30 a second.
export const CLIPS = {
  read: 'phone/02-read-light',
  comment: 'tablet/05-comment-light',
  ai: 'desktop/11-ai-light',
  sign: 'desktop/08-sign-light',
};
const still = (path) => `/assets/${lang}/${path}-light.webp`;
const frameAt = (clip, sec, count, type = 'jpg') =>
  `/_frames/${lang}/${clip}/${String(Math.min(count, Math.max(1, Math.floor(sec * 30) + 1))).padStart(4, '0')}.${type}`;

const WORDS = {
  name: { ar: 'محرر PDF', en: 'ZOOD PDF' },
  tagline: { ar: 'اقرأ، وحرّر، ووقّع. والعربية أولًا.', en: 'Read, edit and sign. Arabic first.' },
  read: { ar: ['اقرأ', '[بإصبعك]'], en: ['Read', 'with', '[a finger]'] },
  readOn: { ar: 'آيفون', en: 'iPhone' },
  pen: { ar: ['اكتب', '[بالقلم]'], en: ['Write', 'with', '[the pen]'] },
  penOn: { ar: 'آيباد', en: 'iPad' },
  scan: { ar: ['صوّر', 'الورقة', '[فتصير', 'PDF]'], en: ['Snap', 'paper', 'into', '[a PDF]'] },
  ring: {
    ar: ['اسحب', 'الملف،', 'اختر', 'الأداة،', '[وانتهى]'],
    en: ['Drag', 'the', 'file,', 'pick', 'a', 'tool,', '[done]'],
  },
  ringOn: { ar: 'ويندوز', en: 'Windows' },
  ai: {
    ar: ['اسأل', 'ملفك،', '[والجواب', 'بصفحاته]'],
    en: ['Ask', 'your', 'file.', '[Answers', 'cite', 'pages.]'],
  },
  sign: { ar: ['وقّع', '[في', 'ثوانٍ]'], en: ['Sign', '[in', 'seconds]'] },
  remote: { ar: ['هاتفك', '[جهاز', 'التحكّم]'], en: ['Your', 'phone', 'is', '[the', 'remote]'] },
  all: {
    ar: ['تطبيق', 'واحد', '[على', 'كل', 'أجهزتك]'],
    en: ['One', 'app', '[on', 'every', 'device]'],
  },
  platforms: {
    ar: ['ويندوز', 'ماك', 'آيفون', 'آيباد', 'المتصفح'],
    en: ['Windows', 'Mac', 'iPhone', 'iPad', 'Browser'],
  },
  free: { ar: 'بلا حساب، وملفاتك تبقى عندك', en: 'No account. Your files stay with you.' },
  slide: { ar: 'نتائج الربع الثالث', en: 'Third-quarter results' },
  plan: { ar: 'الخطة القادمة', en: 'What comes next' },
};

// ---- Motion helpers --------------------------------------------------------
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (x, s, e) => clamp((x - s) / (e - s));
const ease = (x) => 1 - (1 - x) ** 3;
const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const spring = (x) => (x >= 1 ? 1 : x <= 0 ? 0 : 1 - Math.cos(x * Math.PI * 2.2) * (1 - x) ** 2.2);
const mix = (a, b, k) => a + (b - a) * k;
/** Into view at a, out of view by b, with a quick in and out. */

// ---- The stage -------------------------------------------------------------
const stage = document.getElementById('stage');
// ZOOD's full logo (the mark, ZOOD and زود), led by the mark in each language.
const logo = await (await fetch(`/assets/brand/logo-${lang}.svg`)).text();
const markup = logo.replace(/<\?xml[^>]*>|<!--[\s\S]*?-->/g, '');

const caption = (key, cls = '') =>
  `<p class="cap ${cls}" data-cap="${key}">${t(WORDS[key])
    .map((w) => {
      const band = w.startsWith('[') || w.endsWith(']');
      return `<span class="w${band ? ' band' : ''}">${w.replace(/[[\]]/g, '')}</span>`;
    })
    .join(' ')}</p>`;
const bars = [0.35, 0.5, 0.45, 0.68, 0.8, 0.92].map((h) => `<i style="--h:${h}"></i>`).join('');

stage.innerHTML = `
  <div class="bg"></div>
  <div class="wipe"></div>
  <div class="blob b1"></div><div class="blob b2"></div>

  <div class="intro">
    <div class="lockup"><div class="logo">${markup}</div><p class="name">PDF</p></div>
    <p class="tagline">${t(WORDS.tagline)}</p>
  </div>

  <div class="ringshot"><img alt=""></div>
  ${caption('ring', 'top dark')}<p class="chip ring-chip" data-chip="ring">${t(WORDS.ringOn)}</p>
  ${caption('read', 'side')}<p class="chip" data-chip="read">${t(WORDS.readOn)}</p>
  ${caption('pen', 'side')}<p class="chip" data-chip="pen">${t(WORDS.penOn)}</p>
  ${caption('scan', 'side')}
  ${caption('ai', 'top')}
  ${caption('sign', 'top')}
  ${caption('remote', 'top dark')}
  ${caption('all', 'top')}

  <div class="dev phone" data-dev="phone">
    <div class="scr"><img class="shot" alt=""><div class="scanline"></div><div class="flash"></div></div>${phoneFrame()}
    <span class="touch"></span>
  </div>
  <div class="pdfcard"><b>PDF</b><span>✓</span></div>

  <div class="dev tablet" data-dev="tablet">
    <div class="scr"><img class="shot" alt="">
      <svg class="ink" viewBox="0 0 100 75" preserveAspectRatio="none"><path pathLength="1" d="M62 52c-6-4-18-4-22 0s4 8 14 8 16-3 15-7-6-5-11-5"/></svg>
    </div>${tabletFrame()}
    <div class="pen"><svg viewBox="0 0 20 120"><path d="M4 8a6 6 0 0 1 12 0v92H4Z" fill="#f2eee9"/><path d="M4 100h12l-6 18Z" fill="#d6c6b8"/><path d="M8.6 114h2.8L10 118.5Z" fill="#977756"/></svg></div>
  </div>

  <div class="dev win" data-dev="win">
    <div class="strip"><i></i><i></i><i></i><span>${t(WORDS.name)}</span></div>
    <div class="scr"><div class="zoom"><img class="shot" alt=""></div><span class="cursor"></span></div>
  </div>

  <div class="remote">
    <div class="mon"><div class="slide">
      <div class="s s1"><p>${t(WORDS.slide)}</p><div class="bars">${bars}</div></div>
      <div class="s s2"><p>${t(WORDS.plan)}</p><ul><li></li><li></li><li></li></ul></div>
      <span class="laser"></span></div><div class="neck"></div><div class="foot"></div></div>
    <div class="rphone"><div class="rscr"><div class="dots"></div><div class="dots lit"></div><div class="rnav"><span>‹</span><span class="next">›</span></div></div>${phoneFrame()}<span class="touch"></span></div>
  </div>

  <div class="all">
    <div class="dev win a-win"><div class="strip"><i></i><i></i><i></i><span>${t(WORDS.name)}</span></div><div class="scr"><img alt="" src="${still('desktop/04-edit')}"></div></div>
    <div class="dev tablet a-tab"><div class="scr"><img alt="" src="${still('tablet/05-comment')}"></div>${tabletFrame()}</div>
    <div class="dev phone a-phone"><div class="scr"><img alt="" src="${still('phone/01-home')}"></div>${phoneFrame()}</div>
  </div>

  <div class="outro">
    <div class="lockup"><div class="logo">${markup}</div><p class="name">PDF</p></div>
    <ul class="plats">${t(WORDS.platforms)
      .map((p) => `<li>${p}</li>`)
      .join('')}</ul>
    <p class="free">${t(WORDS.free)}</p>
    <p class="url">pdf.zoodrealty.com</p>
  </div>
`;

const $ = (s) => stage.querySelector(s);
const $$ = (s) => [...stage.querySelectorAll(s)];
const put = (el, { x = 0, y = 0, s = 1, r = 0, ry = 0, o = 1, blur = 0 } = {}) => {
  el.style.opacity = o.toFixed(3);
  el.style.visibility = o <= 0.001 ? 'hidden' : 'visible';
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) perspective(2400px) rotateY(${ry.toFixed(2)}deg) rotate(${r.toFixed(2)}deg) scale(${s.toFixed(4)})`;
  el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(1)}px)` : '';
};
const vars = (el, o) =>
  Object.entries(o).forEach(([k, v]) =>
    el.style.setProperty(`--${k}`, typeof v === 'number' ? v.toFixed(3) : v),
  );
// Words pop in one after another, then leave together.
function words(key, x, a, b) {
  const el = $(`[data-cap="${key}"]`);
  const on = x >= a - 0.01 && x <= b;
  el.style.visibility = on ? 'visible' : 'hidden';
  if (!on) return;
  const out = ease(span(x, b - 0.3, b));
  el.querySelectorAll('.w').forEach((w, k) => {
    const p = spring(span(x, a + k * 0.09, a + k * 0.09 + 0.55));
    w.style.opacity = clamp(p * 3 * (1 - out)).toFixed(3);
    w.style.transform = `translateY(${((1 - p) * 70 - out * 40).toFixed(1)}px) scale(${(0.6 + p * 0.4).toFixed(3)})`;
  });
  vars(el, { band: ease(span(x, a + 0.45, a + 0.9)) });
}
const side = rtl ? -1 : 1; // devices sit on the start side's opposite: left in Arabic

// The images that changed this frame, so the capture waits for them.
const pending = [];
function src(img, url) {
  if (img.getAttribute('src') === url) return;
  img.setAttribute('src', url);
  pending.push(img.decode().catch(() => {}));
}

let counts = {};
export function setCounts(c) {
  counts = c;
}

// ---- The film --------------------------------------------------------------
// The ring comes second, so the later scenes were timed on a clock that
// pauses for it: warp() turns film time into that clock.
const KNOTS = [
  [0, 0],
  [2.5, 2.95],
  [6.45, 2.96],
  [6.5, 3],
  [9.5, 7],
  [13, 11],
  [15.5, 14],
  [19, 18],
  [22, 21.5],
  [25.5, 25],
  [30, 30],
];
function warp(n) {
  for (let k = 1; k < KNOTS.length; k++) {
    const [n1, o1] = KNOTS[k];
    const [n0, o0] = KNOTS[k - 1];
    if (n <= n1) return mix(o0, o1, span(n, n0, n1));
  }
  return n;
}
// The ring's frames, captured from the site's own ring section (make.mjs).
const RING = [2.6, 6.3];

async function render(n) {
  pending.length = 0;
  const x = warp(n);
  const bg = $('.bg');
  // Scene colours: navy for the opening, the ring, the remote and the close;
  // paper and soft tints between. A circle of the next colour opens from the
  // middle at each change.
  const cuts = [
    [0, '#041e42'],
    [6.5, '#f3efe9'],
    [9.5, '#e8eef6'],
    [13, '#f3efe9'],
    [15.5, '#efe9e2'],
    [22, '#041e42'],
    [25.5, '#f3efe9'],
  ];
  bg.style.background = cuts.findLast(([c]) => n >= c)[1];
  const wipe = $('.wipe');
  const cut = cuts.find(([c]) => c > 0 && n >= c - 0.4 && n < c);
  if (cut) {
    wipe.style.visibility = 'visible';
    wipe.style.background = cut[1];
    wipe.style.clipPath = `circle(${(ease(span(n, cut[0] - 0.4, cut[0])) * 1200).toFixed(0)}px at 50% 50%)`;
  } else wipe.style.visibility = 'hidden';

  // The ring: drag files with Ctrl, the ring opens, drop on a tool (2.5-6.5).
  {
    const ring = $('.ringshot');
    const on = n >= 2.45 && n < 6.5;
    const inn = spring(span(n, 2.5, 3.1));
    const out = ease(span(n, 6.1, 6.45));
    put(ring, {
      y: 270 + (1 - inn) * 200,
      s: 0.9 + inn * 0.1 + out * 0.15,
      o: on ? clamp(inn * 3) * (1 - out) : 0,
      blur: out * 10,
    });
    if (on)
      src(
        ring.querySelector('img'),
        frameAt(
          'ring',
          ((n - RING[0]) / (RING[1] - RING[0])) * (counts.ring / 30),
          counts.ring,
          'png',
        ),
      );
    words('ring', n, 2.8, 6.35);
    const chip = $('[data-chip="ring"]');
    const cp = spring(span(n, 3.6, 4.1)) * (1 - ease(span(n, 6.0, 6.35)));
    put(chip, { s: 0.5 + cp * 0.5, o: clamp(cp * 3) });
  }

  vars(stage, { drift: x / LENGTH });

  // 1. The name (0-3).
  {
    const intro = $('.intro');
    const out = ease(span(x, 2.55, 2.95));
    put(intro, { s: 1 + out * 0.5, o: 1 - out, blur: out * 12 });
    put(intro.querySelector('.logo'), {
      s: spring(span(x, 0.15, 1.0)),
      r: (1 - ease(span(x, 0.15, 0.9))) * -8,
    });
    put(intro.querySelector('.name'), {
      x: (1 - spring(span(x, 0.7, 1.3))) * side * -60,
      o: span(x, 0.7, 0.95),
    });
    put(intro.querySelector('.tagline'), {
      y: (1 - ease(span(x, 1.25, 1.8))) * 30,
      o: span(x, 1.25, 1.6),
    });
  }

  // 2. iPhone, reading with a finger (3-7).
  // 4. iPhone, scanning paper (11-14), the same phone.
  {
    const phone = $('.phone');
    const shot = phone.querySelector('.shot');
    const touch = phone.querySelector('.touch');
    const cx = 960 + side * 420;
    if (x >= 2.97 && x < 7.1) {
      const inn = spring(span(x, 3.0, 3.75));
      const out = ease(span(x, 6.65, 7.0));
      put(phone, {
        x: cx - 210 - side * out * 900,
        y: 130 + (1 - inn) * 900,
        r: (1 - inn) * 14 * side - out * 12 * side,
        ry: (1 - inn) * -25 * side,
        o: 1,
      });
      src(shot, frameAt(CLIPS.read, 0.4 + (x - 3.2) * 1.35, counts.read));
      // A finger swipes up the page, twice.
      const sw = (x - 3.9) % 1.35;
      const on = x > 3.9 && x < 6.6 && sw < 0.85;
      vars(touch, {
        tx: '58%',
        ty: `${mix(72, 34, inOut(span(sw, 0.1, 0.7))).toFixed(1)}%`,
        on: on ? clamp(Math.min(sw / 0.1, (0.85 - sw) / 0.12)) : 0,
        press: on ? 1 : 0,
      });
      vars(phone, { scan: 0, flash: 0 });
    } else if (x >= 10.9 && x < 14.1) {
      const inn = spring(span(x, 11.0, 11.7));
      const out = ease(span(x, 13.7, 14.05));
      put(phone, {
        x: cx - 210 + side * (1 - inn) * 700,
        y: 130 - out * 1000,
        r: (1 - inn) * -10 * side,
        o: 1,
        s: 1 + out * 0.1,
      });
      src(shot, still('phone/10-scan'));
      vars(phone, {
        scan: ((x - 11.6) % 0.9) / 0.9,
        flash: x > 12.6 ? clamp(1 - (x - 12.6) / 0.35) : 0,
      });
      vars(touch, { on: 0 });
    } else put(phone, { o: 0 });
    // The photo turns into a PDF and jumps out of the phone.
    const card = $('.pdfcard');
    const pop = spring(span(x, 12.7, 13.2));
    const away = ease(span(x, 13.65, 14.0));
    put(card, {
      x: cx - 120 + side * pop * 250,
      y: 380 - pop * 120 - away * 900,
      r: pop * -8 * side,
      s: 0.4 + pop * 0.6,
      o: x > 12.7 && x < 14.05 ? clamp(pop * 3) : 0,
    });
    words('read', x, 3.5, 6.85);
    words('scan', x, 11.4, 13.85);
    const chip = $('[data-chip="read"]');
    const cp = spring(span(x, 4.4, 4.9)) * (1 - ease(span(x, 6.5, 6.85)));
    put(chip, { s: 0.5 + cp * 0.5, o: clamp(cp * 3) });
  }

  // 3. iPad and the pen (7-11).
  {
    const tab = $('.tablet');
    if (x >= 6.9 && x < 11.1) {
      const inn = spring(span(x, 7.0, 7.8));
      const out = ease(span(x, 10.65, 11.0));
      put(tab, {
        x: 960 + side * 330 - 560 - side * out * 200,
        y: 210 + (1 - inn) * 120 - out * 60,
        ry: (1 - inn) * 55 * side,
        s: 0.7 + inn * 0.3 - out * 0.2,
        o: clamp(inn * 2) * (1 - out),
      });
      src(
        tab.querySelector('.shot'),
        frameAt(CLIPS.comment, 0.6 + (x - 7.2) * 1.2, counts.comment),
      );
      // The pen comes down, circles a figure, and lifts.
      const ink = inOut(span(x, 8.5, 9.8));
      const path = tab.querySelector('.ink path');
      const at = path.getPointAtLength(ink * path.getTotalLength());
      const pen = tab.querySelector('.pen');
      const down = ease(span(x, 8.0, 8.5)) * (1 - ease(span(x, 10.0, 10.5)));
      vars(tab, { ink, inkon: x > 8.5 ? 1 : 0 });
      const scr = tab.querySelector('.scr');
      const sx = scr.offsetLeft + (at.x / 100) * scr.offsetWidth;
      const sy = scr.offsetTop + (at.y / 75) * scr.offsetHeight;
      put(pen, {
        x: sx - 28 + (1 - down) * 160,
        y: sy - 332 - (1 - down) * 160,
        r: 28,
        o: clamp(down * 3),
      });
    } else put(tab, { o: 0 });
    words('pen', x, 7.5, 10.85);
    const chip = $('[data-chip="pen"]');
    const cp = spring(span(x, 8.3, 8.8)) * (1 - ease(span(x, 10.5, 10.85)));
    put(chip, { s: 0.5 + cp * 0.5, o: clamp(cp * 3) });
  }

  // 5. The assistant on the computer (14-18), 6. signing (18-21.5).
  {
    const win = $('.win:not(.a-win)');
    const shot = win.querySelector('.shot');
    const zoom = win.querySelector('.zoom');
    if (x >= 13.9 && x < 21.6) {
      const inn = spring(span(x, 14.0, 14.7));
      const out = ease(span(x, 21.15, 21.5));
      put(win, {
        x: 960 - 600,
        y: 250 + (1 - inn) * 500,
        s: 0.85 + inn * 0.15 - out * 0.3,
        o: clamp(inn * 3) * (1 - out),
        blur: out * 10,
      });
      if (x < 18) {
        src(shot, frameAt(CLIPS.ai, 0.2 + (x - 14.3) * 1.9, counts.ai));
        const z = inOut(span(x, 15.1, 15.9)) * (1 - inOut(span(x, 17.5, 18)));
        vars(zoom, { z: 1 + z * 1.0, ox: rtl ? '8%' : '90%', oy: '50%' });
      } else {
        src(shot, frameAt(CLIPS.sign, 2.6 + (x - 18) * 2.3, counts.sign));
        const z = inOut(span(x, 18.2, 18.9)) * (1 - inOut(span(x, 20.7, 21.2)));
        vars(zoom, { z: 1 + z * 0.85, ox: '50%', oy: '45%' });
      }
    } else put(win, { o: 0 });
    words('ai', x, 14.5, 17.85);
    words('sign', x, 18.2, 21.3);
  }

  // 7. The phone is the remote (21.5-25).
  {
    const rm = $('.remote');
    const on = x >= 21.3 && x < 25.1;
    const inn = spring(span(x, 21.6, 22.3));
    const out = ease(span(x, 24.65, 25));
    put(rm, { y: (1 - inn) * 300, s: 1 - out * 0.15, o: on ? clamp(inn * 3) * (1 - out) : 0 });
    if (on) {
      // The finger draws across the pad; the laser follows on the slide.
      const k = span(x, 22.5, 23.9);
      const lx = mix(18, 82, inOut(k));
      const ly = 62 - Math.sin(k * Math.PI) * 36 + Math.sin(k * 9) * 4;
      const tap = x > 24.05 && x < 24.6;
      vars(rm, {
        lx: `${lx.toFixed(1)}%`,
        ly: `${ly.toFixed(1)}%`,
        laser: x > 22.5 && x < 24 ? 1 : 0,
        gx: `${lx.toFixed(1)}%`,
        gy: `${(ly * 0.62).toFixed(1)}%`,
        glow: x > 22.4 && x < 24 ? 1 : 0,
        tx: tap ? '72%' : `${(10 + lx * 0.8).toFixed(1)}%`,
        ty: tap ? '84%' : `${(14 + ly * 0.62 * 0.62).toFixed(1)}%`,
        touch: x > 22.4 && x < 24.6 ? 1 : 0,
        press: tap && x < 24.25 ? 1 : 0,
        turn: ease(span(x, 24.2, 24.5)),
      });
    }
    words('remote', x, 21.8, 24.85);
  }

  // 8. Every device, then the name (25-30).
  {
    const all = $('.all');
    const on = x >= 25 && x < 30;
    const up = ease(span(x, 27.2, 27.8));
    put(all, { y: -up * 120, s: 1 - up * 0.35, o: on ? 1 - up : 0, blur: up * 8 });
    const items = [
      ['.a-win', 0, 0],
      ['.a-tab', 0.2, -1],
      ['.a-phone', 0.35, 1],
    ];
    for (const [sel, d, dir] of items) {
      const p = spring(span(x, 25.15 + d, 25.85 + d));
      put(all.querySelector(sel), { y: (1 - p) * 500, r: (1 - p) * dir * 10, o: clamp(p * 3) });
    }
    words('all', x, 25.4, 27.4);
    const outro = $('.outro');
    put(outro, { o: x > 27.3 ? 1 : 0 });
    put(outro.querySelector('.logo'), {
      s: spring(span(x, 27.4, 28.1)),
      r: (1 - ease(span(x, 27.4, 28))) * 6,
    });
    put(outro.querySelector('.name'), {
      x: (1 - spring(span(x, 27.75, 28.3))) * side * -40,
      o: span(x, 27.75, 28),
    });
    outro.querySelectorAll('.plats li').forEach((li, k) => {
      const p = spring(span(x, 28.1 + k * 0.08, 28.6 + k * 0.08));
      put(li, { y: (1 - p) * 40, s: 0.6 + p * 0.4, o: clamp(p * 3) });
    });
    put(outro.querySelector('.free'), {
      o: span(x, 28.7, 29),
      y: (1 - ease(span(x, 28.7, 29.1))) * 20,
    });
    put(outro.querySelector('.url'), {
      o: span(x, 28.9, 29.2),
      y: (1 - ease(span(x, 28.9, 29.3))) * 20,
    });
  }

  await Promise.all(pending);
  await document.fonts.ready;
}

window.render = render;
window.setCounts = setCounts;
window.FILM = { LENGTH, FPS, CLIPS };
window.ready = true;
