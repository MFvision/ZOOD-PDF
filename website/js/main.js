// The story page and the shared chrome (top bar, footer) of every page.
// One requestAnimationFrame loop, started by scroll and resize events, reads
// the scroll position and writes CSS custom properties; css/site.css turns
// them into transform and opacity. No scroll-driven CSS animations: on the
// reference site they froze in Safari 26 and in Chrome on Windows.
import {
  CHAPTERS,
  DESK,
  DOWNLOADS,
  FOOTER,
  PLATFORMS,
  SCREENS,
  SITE,
  TOOLS,
  UI,
  WALL,
} from './story.js';
import { buildStage, phoneFrame, tabletFrame } from './desk.js';
import { startDrip } from './drip.js';
import { playGather } from './gather.js';
import { startInteractions } from './interact.js';
import { ringScene, ringFrame } from './ring.js';
import { aiScene, aiFrame } from './ai-room.js';
import { libraryScene, libraryFrame } from './library.js';
import { phoneScene, phoneFrame as phoneRoomFrame } from './phone-room.js';
import { familyScene, familyFrame } from './family.js';
import { remoteScene, remoteFrame } from './remote.js';

const root = document.documentElement;
export const lang = root.lang === 'en' ? 'en' : 'ar';
export const t = (text) => (text && typeof text === 'object' ? text[lang] : (text ?? ''));
const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const narrow = matchMedia('(max-width: 899px)');
let reduced = reduceQuery.matches;

export const urlFor = (language, slug = '') =>
  (language === 'ar' ? '/' : '/en/') + (slug ? `${slug}/` : '');
const resolvedTheme = () => root.dataset.theme ?? (darkQuery.matches ? 'dark' : 'light');
const screenSrc = (device, name, theme = resolvedTheme(), type = 'webp') =>
  `/assets/${lang}/${device}/${SCREENS.files[name]}-${theme}.${type}`;
// The chapters' screens are short videos of the tool at work, shown over the
// still picture once they play; the still stays with Reduce Motion or Save Data.
const clipsAllowed = () => !reduced && !navigator.connection?.saveData;
const clipType = document.createElement('video').canPlayType('video/webm; codecs="vp9"')
  ? 'webm'
  : 'mp4';

const escape = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

// "PDFs, [[done right]]." → words that rise in one by one, the [[phrase]] banded.
function titleHtml(text) {
  let i = 0;
  const words = (s) =>
    s
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `<span class="w" style="--wi:${i++}">${escape(w)}</span>`)
      .join(' ');
  return t(text).replace(/^(.*?)\[\[(.*?)\]\](.*)$/, (_, a, b, c) => {
    const before = words(a);
    const start = i;
    // Punctuation right after the phrase stays on the line of its last word.
    const [, punct, rest] = /^(\S*)(.*)$/.exec(c);
    const parts = b.split(/\s+/).filter(Boolean);
    const last = parts.pop();
    let hl = words(parts.join(' '));
    const tail = `<span class="w" style="--wi:${i++}">${escape(last)}</span>`;
    const end = punct
      ? `<span class="nw">${tail}<span class="w p" style="--wi:${i++}">${escape(punct)}</span></span></mark>`
      : `${tail}</mark>`;
    hl = `<mark class="hl" style="--wn:${start}">${hl}${hl ? ' ' : ''}${end}`;
    const after = words(rest);
    return `${before}${before && /\s$/.test(a) ? ' ' : ''}${hl}${after ? ' ' : ''}${after}`;
  });
}

// ---- Shared chrome ---------------------------------------------------------
const THEME_ICONS = {
  auto: '<svg class="theme-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor"/></svg>',
  light:
    '<svg class="theme-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 1.5v2.5M10 16v2.5M1.5 10H4M16 10h2.5M4 4l1.8 1.8M14.2 14.2 16 16M4 16l1.8-1.8M14.2 5.8 16 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  dark: '<svg class="theme-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 12.5A7 7 0 0 1 7.5 4.5a7 7 0 1 0 8 8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};

export function topBar(slug) {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  const choice = root.dataset.theme ?? 'auto';
  bar.innerHTML = `<a class="brand" href="${urlFor(lang)}${slug ? '' : '#top'}" aria-label="${escape(t(UI.home))}"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">${escape(t(SITE.name))}</span></a>
    <nav class="switch lang-switch" aria-label="${escape(t(UI.language))}">
      <a href="${urlFor('ar', slug)}" lang="ar" hreflang="ar" aria-current="${lang === 'ar'}">العربية</a>
      <a href="${urlFor('en', slug)}" lang="en" hreflang="en" aria-current="${lang === 'en'}">English</a>
    </nav>
    <div class="switch theme-switch" role="group" aria-label="${escape(t(UI.theme))}">
      ${['auto', 'light', 'dark']
        .map(
          (k) =>
            `<button type="button" data-theme-choice="${k}" aria-pressed="${choice === k}" aria-label="${escape(t(UI.themes[k]))}">${THEME_ICONS[k]}<span class="theme-label" aria-hidden="true">${escape(t(UI.themes[k]))}</span></button>`,
        )
        .join('')}
    </div>`;
  bar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-choice]');
    if (!button) return;
    const k = button.dataset.themeChoice;
    if (k === 'auto') delete root.dataset.theme;
    else root.dataset.theme = k;
    try {
      if (k === 'auto') localStorage.removeItem('zood-site-theme');
      else localStorage.setItem('zood-site-theme', k);
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
    bar
      .querySelectorAll('[data-theme-choice]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    document.dispatchEvent(new Event('themechange'));
  });
  return bar;
}

export function footer() {
  const el = document.createElement('footer');
  el.className = 'footer';
  const links = FOOTER.links.map(
    (l) =>
      `<li><a href="${urlFor(lang, l.href.replace(/\/$/, ''))}">${escape(t(l.label))}</a></li>`,
  );
  if (SITE.showSource)
    links.push(
      `<li><a href="${SITE.sourceUrl}" rel="noopener">${escape(t(FOOTER.source))}</a></li>`,
    );
  el.innerHTML = `<div class="footer-in">
    <a class="brand" href="${urlFor(lang)}"><span class="brand-mark" aria-hidden="true"></span><span>${escape(t(SITE.name))}</span></a>
    <p>${escape(t(FOOTER.tagline))}</p>
    <nav aria-label="${escape(t(FOOTER.links[0].label))} · ${escape(t(FOOTER.links[1].label))} · ${escape(t(FOOTER.links[2].label))}"><ul>${links.join('')}</ul></nav>
    <p>${escape(t(FOOTER.copyright))}</p>
    <p>${escape(t(FOOTER.marks))}</p>
  </div>`;
  return el;
}

// The licensed headline face is loaded only when the deploy carries it
// (assets/fonts/licensed/, git-ignored), so a clean checkout makes no failed request.
export function headlineFont() {
  if (!SITE.licensedHeadlineFont || lang !== 'ar') return;
  const face = new FontFace(
    'Huwiya',
    'url(/assets/fonts/licensed/huwiya-medium.woff2) format("woff2")',
    {
      weight: '400 700',
      display: 'swap',
      unicodeRange: 'U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFF',
    },
  );
  face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
      root.classList.add('licensed-font');
    })
    .catch(() => {});
}

// ---- The story --------------------------------------------------------------
function chapterBody(c, index) {
  const heading = index === 0 ? 'h1' : 'h2';
  const id = `h-${c.id}`;
  let body = `<p class="eyebrow">${escape(t(c.eyebrow))}</p><${heading} class="title" id="${id}">${titleHtml(c.title)}</${heading}>`;
  if (c.lead) body += `<p class="lead">${escape(t(c.lead))}</p>`;
  if (c.points)
    body += `<ul class="points">${c.points.map((p, k) => `<li style="--pi:${k}">${escape(t(p))}</li>`).join('')}</ul>`;
  if (c.kind === 'platforms') {
    body += `<ul class="platforms">${PLATFORMS.map((p) => `<li><strong>${escape(t(p.name))}</strong><span>${escape(t(p.status))}</span></li>`).join('')}</ul>`;
  }
  if (c.kind === 'download') {
    body += `<ul class="downloads">${DOWNLOADS.map((d) =>
      d.href
        ? `<li><a href="${escape(d.href)}" rel="noopener">${escape(t(d.label))}</a></li>`
        : `<li><span class="soon">${escape(t(d.label))} <span>${escape(t(UI.comingSoon))}</span></span></li>`,
    ).join('')}</ul>`;
  }
  if (c.note) body += `<p class="note">${escape(t(c.note))}${escape(t(c.note.on))}.</p>`;
  if (c.cta) body += `<a class="button" href="${c.cta.href}">${escape(t(c.cta.label))}</a>`;
  if (c.more)
    body += `<a class="text-link" href="${urlFor(lang, c.more.href.replace(/\/$/, ''))}">${escape(t(c.more.label))}</a>`;
  if (c.devices?.length) {
    body += `<p class="sr-only">${c.devices.map((d) => escape(t(UI.screen)) + escape(t(SCREENS.alt[d.screen]))).join('. ')}</p>`;
  }
  return body;
}

function chapterHtml(c, index) {
  const id = `h-${c.id}`;
  const body = chapterBody(c, index);
  const cls = [
    'chapter',
    c.kind === 'hero' ? 'hero' : '',
    ['platforms', 'download'].includes(c.kind) ? 'short' : '',
    c.stage?.dusk >= 1 ? 'dusk' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<section class="${cls}" id="${c.id}" data-chapter="${index}" aria-labelledby="${id}"><div class="words"><div class="card">${body}</div></div></section>`;
}

// The rooms: the words beside a scene the scroll plays (js/ring.js and friends).
// The ring's room is dark; the others are light glass that follows the theme.
const media = {
  size: (device) => SCREENS[device].size,
  still: (device, name) => screenSrc(device, name),
  clip: (device, name) => (clipsAllowed() ? screenSrc(device, name, undefined, clipType) : ''),
};
const ROOMS = {
  ring: { scene: () => ringScene(t, escape), frame: ringFrame },
  ai: { scene: () => aiScene(t, escape, media), frame: aiFrame },
  library: { scene: () => libraryScene(t, escape), frame: libraryFrame },
  phone: { scene: () => phoneScene(t, escape, media, phoneFrame()), frame: phoneRoomFrame },
  remote: { scene: () => remoteScene(t, escape, phoneFrame()), frame: remoteFrame },
  family: {
    scene: () => familyScene(t, escape, media, { phone: phoneFrame(), tablet: tabletFrame() }),
    frame: familyFrame,
  },
};

function roomHtml(c, index) {
  const cls = c.kind === 'ring' ? 'ring-ch' : `ring-ch room room-${c.kind}`;
  return `<section class="${cls}" id="${c.id}" data-chapter="${index}" aria-labelledby="h-${c.id}">
    <div class="ring-stage"><div class="ring-words"><div class="card">${chapterBody(c, index)}</div></div>${ROOMS[c.kind].scene()}</div>
  </section>`;
}

function wallHtml(c, index) {
  const cols = [];
  const side = WALL.columns;
  // Two columns either side of the middle; the outer ones hide on phones.
  const order = [side[0], side[1], null, side[2], side[3]];
  order.forEach((list, j) => {
    if (!list) {
      cols.push(
        `<div class="wall-col middle" data-col="middle">${WALL.middle.map((n) => `<img alt="" data-screen="${n}" width="640" height="1386" decoding="async">`).join('')}</div>`,
      );
      return;
    }
    const cells = [...list, ...list, ...list];
    const far = j === 0 || j === 4 ? ' far' : '';
    const theme = j % 2 ? 'dark' : 'light';
    cols.push(
      `<div class="wall-col${far}" data-col="${j}" data-theme="${theme}">${cells.map((n) => `<img alt="" data-screen="${n}" width="640" height="1386" decoding="async">`).join('')}</div>`,
    );
  });
  const id = `h-${c.id}`;
  const names = WALL.middle
    .map((n) => `<li>${escape(t(UI.screen))}${escape(t(WALL.names[n]))}</li>`)
    .join('');
  return `<section class="wall" id="${c.id}" data-chapter="${index}" aria-labelledby="${id}" style="height:calc(100svh + ${WALL.middle.length - 1} * 62svh + 40svh)">
    <div class="wall-stage">
      <div class="wall-head"><p class="eyebrow">${escape(t(c.eyebrow))}</p><h2 class="title" id="${id}">${titleHtml(c.title)}</h2></div>
      <div class="wall-cols" aria-hidden="true">${cols.join('')}</div>
      <div class="wall-fade" aria-hidden="true"></div>
      <div class="wall-device" aria-hidden="true">${phoneFrame()}</div>
      <ul class="sr-only">${names}</ul>
    </div>
  </section>`;
}

function insideHtml(c) {
  const tool = (x) =>
    `<li><h3>${escape(t(x.name))}${x.tool ? '' : ''}</h3><p>${escape(t(x.text))}</p>${x.on ? `<p class="where">${escape(t(UI.where))}${escape(t(x.on))}</p>` : ''}</li>`;
  return `<section class="inside" id="${c.id}" aria-labelledby="h-${c.id}">
    <div class="inside-head"><p class="eyebrow">${escape(t(c.eyebrow))}</p><h2 class="title" id="h-${c.id}">${titleHtml(c.title)}</h2><p class="lead">${escape(t(c.lead))}</p></div>
    <ul class="tools">${TOOLS.map(tool).join('')}</ul>
  </section>`;
}

function dockHtml() {
  const imgs = (device) => {
    const [w, h] = SCREENS[device].size;
    return `<div class="screen"><img alt="" width="${w}" height="${h}" decoding="async"><img alt="" width="${w}" height="${h}" decoding="async"><video muted loop playsinline disablepictureinpicture preload="none" width="${w}" height="${h}"></video></div>`;
  };
  return `<div class="dock" aria-hidden="true">
    <div class="device device-browser" data-frame="browser"><div class="browser-tabs"><div class="browser-tab">${escape(t(SCREENS.browserFile))}</div></div><div class="browser-bar"><div class="browser-address">${escape(t(SITE.name))} · ${escape(t(SCREENS.browserFile))}</div></div>${imgs('browser')}</div>
    <div class="device device-tablet" data-frame="tablet">${imgs('tablet')}${tabletFrame()}</div>
    <div class="device device-desktop" data-frame="desktop"><div class="win-strip">${escape(t(SITE.name))}</div>${imgs('desktop')}</div>
    <div class="device device-phone" data-frame="phone">${imgs('phone')}${phoneFrame()}</div>
  </div>`;
}

function indexHtml(chapters) {
  return `<nav class="index" aria-label="${escape(t(UI.chapters))}"><ol>${chapters
    .map(
      (c) =>
        `<li><a href="#${c.id}" data-target="${c.id}" aria-current="false"><span>${escape(t(c.eyebrow))}</span></a></li>`,
    )
    .join('')}</ol></nav>`;
}

// ---- Motion -----------------------------------------------------------------
const ACTIONS = [
  'turn',
  'flow',
  'find',
  'reflow',
  'mark',
  'order',
  'merge',
  'thin',
  'sign',
  'redact',
  'scan',
];
const POSE = { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0, frame: 0 };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x) => x * x * (3 - 2 * x);

function startStory() {
  const story = CHAPTERS.filter((c) => c.kind !== 'inside');
  const inside = CHAPTERS.find((c) => c.kind === 'inside');
  const skip = document.createElement('a');
  skip.className = 'skip';
  skip.href = `#${inside.id}`;
  skip.textContent = t(UI.skip);

  const stage = buildStage({ search: t(DESK.search), sizes: DESK.sizes });
  const wrapper = document.createElement('div');
  wrapper.innerHTML = dockHtml() + indexHtml(CHAPTERS);
  const dock = wrapper.querySelector('.dock');
  const index = wrapper.querySelector('.index');
  const main = document.createElement('main');
  main.id = 'main';
  main.innerHTML =
    story
      .map((c, i) =>
        c.kind === 'wall' ? wallHtml(c, i) : ROOMS[c.kind] ? roomHtml(c, i) : chapterHtml(c, i),
      )
      .join('') + insideHtml(inside);

  document.body.prepend(skip, topBar(''), stage, dock, index, main);
  const drip = startDrip(
    stage.querySelector('.desk-pattern'),
    new URL('../assets/brand/pattern.svg', import.meta.url).href,
  );
  document.body.append(footer());

  const sections = [...main.querySelectorAll('[data-chapter]')];
  const rooms = story.flatMap((c, k) => (ROOMS[c.kind] ? [[k, ROOMS[c.kind].frame]] : []));
  const insideEl = main.querySelector('.inside');
  const wall = main.querySelector('.wall');
  const wallCols = [...wall.querySelectorAll('.wall-col')];
  const wallStage = wall.querySelector('.wall-stage');
  const langLinks = [...document.querySelectorAll('.lang-switch a')];
  const indexLinks = [...index.querySelectorAll('a')];
  const frames = Object.fromEntries(
    [...dock.querySelectorAll('[data-frame]')].map((f) => [f.dataset.frame, f]),
  );

  // Titles rise in once each, when they first come into view.
  const seen = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.closest('section').classList.add('seen');
          seen.unobserve(e.target);
        }
      }),
    { rootMargin: '0px 0px -12% 0px' },
  );
  document.querySelectorAll('main .title').forEach((el) => seen.observe(el));

  let tops = [];
  let heights = [];
  let insideTop = 0;
  let vh = innerHeight;
  let wallTop = 0;
  let wallHeight = 0;
  let cell = 0;
  let gap = 0;
  let stageH = 0;
  let lastActive = -1;
  let lastHash = '';
  const written = new Map();

  function measure() {
    vh = innerHeight;
    // Document offsets, read once per resize rather than per frame.
    tops = sections.map((s) => s.getBoundingClientRect().top + scrollY);
    heights = sections.map((s) => s.offsetHeight);
    drip.layout();
    insideTop = insideEl.getBoundingClientRect().top + scrollY;
    wallTop = wall.getBoundingClientRect().top + scrollY;
    wallHeight = wall.offsetHeight;
    stageH = wallStage.offsetHeight;
    const first = wall.querySelector('.wall-col.middle img');
    cell = first.getBoundingClientRect().height;
    gap = parseFloat(getComputedStyle(first.parentElement).rowGap) || 0;
    schedule();
  }

  function write(el, name, value) {
    const key = el === stage ? name : `${name}@${el.dataset.col ?? ''}`;
    const v = typeof value === 'number' ? (Math.round(value * 1000) / 1000).toString() : value;
    if (written.get(key) === v) return;
    written.set(key, v);
    el.style.setProperty(name, v);
  }

  function playClip(video, src) {
    if (video.dataset.src === src) return;
    video.dataset.src = src;
    video.classList.remove('on');
    video.pause();
    if (!src) return;
    video.addEventListener(
      'playing',
      () => video.dataset.src === src && video.classList.add('on'),
      { once: true },
    );
    video.src = src;
    video.play().catch(() => {});
  }

  function setDevices(chapter) {
    const wanted = new Map((chapter?.devices ?? []).map((d) => [d.frame, d.screen]));
    for (const [frame, el] of Object.entries(frames)) {
      const screen = wanted.get(frame);
      el.classList.toggle('on', Boolean(screen));
      playClip(
        el.querySelector('.screen video'),
        screen && clipsAllowed() ? screenSrc(frame, screen, undefined, clipType) : '',
      );
      if (!screen) continue;
      const src = screenSrc(frame, screen);
      const [a, b] = el.querySelectorAll('.screen img');
      const current = a.classList.contains('on') ? a : b.classList.contains('on') ? b : null;
      if (current && current.getAttribute('src') === src) continue;
      // Cross-fade in the same frame: the new screen loads under, then fades in.
      const next = current === a ? b : a;
      const show = () => {
        next.classList.add('on');
        if (current) current.classList.remove('on');
      };
      next.onload = show;
      next.setAttribute('src', src);
      if (next.complete && next.naturalWidth) show();
    }
  }

  function update() {
    ticking = false;
    const y = scrollY + vh * 0.5;
    let i = 0;
    while (i < sections.length - 1 && y >= tops[i + 1]) i++;
    const local = (k) => (y - tops[k]) / heights[k];
    const ti = local(i);
    const next = i + 1 < sections.length ? i + 1 : i;
    let w = next === i ? 0 : smooth(clamp((ti - 0.8) / 0.2));
    if (reduced) w = w >= 0.5 ? 1 : 0;

    // Pose: blended between this chapter and the next.
    const a = { ...POSE, ...story[i].stage };
    const b = { ...POSE, ...story[next].stage };
    for (const k of Object.keys(POSE)) write(stage, `--${k}`, a[k] + (b[k] - a[k]) * w);
    // The pattern runs down as the chapter plays, and slides off as the next begins.
    drip.set(clamp(ti / 0.8), next === i ? 0 : w, reduced);

    // Actions: each plays across its chapter, present while that chapter is.
    const values = Object.fromEntries(ACTIONS.map((n) => [n, { p: 0, on: 0 }]));
    for (const [k, presence] of [
      [i, 1 - w],
      [next, next === i ? 0 : w],
    ]) {
      const acts = story[k].act ?? {};
      const tk = clamp(local(k), 0, 1);
      for (const [name, [s, e]] of Object.entries(acts)) {
        let p = clamp((tk - s) / (e - s));
        if (reduced) p = p >= 0.5 ? 1 : 0;
        if (presence >= values[name].on) values[name] = { p, on: presence };
      }
    }
    for (const name of ACTIONS) {
      const { p, on } = values[name];
      if (name === 'flow') {
        // The Arabic page is written out everywhere except while it is being written.
        write(stage, '--flow', 1 - on * (1 - p));
      } else if (name === 'merge') {
        write(stage, '--merge', p * on);
      } else {
        write(stage, `--${name}`, p);
        write(stage, `--${name}-on`, on);
      }
    }

    // Each room plays across its own scroll, while it or a neighbour is on screen.
    for (const [k, frame] of rooms) {
      if (Math.abs(i - k) <= 1)
        frame(sections[k], clamp((scrollY - tops[k]) / (heights[k] - vh)), reduced);
    }

    // On a phone the cards rest under the devices; a card leaving upwards fades
    // before it reaches them.
    if (narrow.matches) {
      const floor = dock.getBoundingClientRect().bottom;
      for (let k = Math.max(0, i - 1); k <= Math.min(sections.length - 1, i + 1); k++) {
        const card = sections[k].querySelector('.words');
        if (!card) continue;
        const top = card.getBoundingClientRect().top;
        const o = clamp((top - floor + vh * 0.1) / (vh * 0.1)).toFixed(2);
        if (card.style.opacity !== o) card.style.opacity = o;
      }
    }

    // Devices and the chapter index follow the chapter that holds the middle of the screen.
    const active = w >= 0.5 ? next : i;
    const pastStory = scrollY + vh * 0.5 >= insideTop;
    const current = pastStory ? CHAPTERS.length - 1 : active;
    if (current !== lastActive) {
      lastActive = current;
      setDevices(pastStory ? null : story[active]);
      const id = CHAPTERS[current].id;
      indexLinks.forEach((l) => l.setAttribute('aria-current', String(l.dataset.target === id)));
      index.classList.toggle('dark', ['wall', 'ring'].includes(story[active]?.kind) && !pastStory);
      if (id !== lastHash) {
        lastHash = id;
        // The language switch keeps your place.
        langLinks.forEach((l) => {
          l.href = `${urlFor(l.hreflang)}#${id}`;
        });
      }
    }

    // The wall: pinned for the whole band. The middle column steps one screen at
    // a time with a stop on each; the side columns glide in opposite directions.
    if (scrollY + vh > wallTop && scrollY < wallTop + wallHeight) {
      const n = WALL.middle.length;
      const travel = Math.max(1, wallHeight - vh);
      const raw = clamp((scrollY - wallTop) / travel);
      const P = clamp(raw * (n - 1 + 0.7) - 0.35, 0, n - 1);
      const step = Math.floor(P);
      const frac = P - step;
      const k = reduced ? Math.round(P) : step + smooth(clamp((frac - 0.45) / 0.55));
      const pitch = cell + gap;
      const screenTop = Math.round(stageH * 0.6 - cell / 2);
      // The phone's screen sits exactly over the middle column's current cell.
      write(wallStage, '--wall-top', screenTop - (cell / 0.9614) * 0.0193);
      wallCols.forEach((col) => {
        let yy;
        if (col.dataset.col === 'middle') {
          yy = screenTop - k * pitch;
        } else {
          const j = Number(col.dataset.col);
          const dir = j % 2 ? 1 : -1;
          const speed = [0.55, 0.85, 0, 0.7, 0.45][j];
          const span = (n - 1) * speed * pitch;
          const base = screenTop - pitch * 0.5 - (dir > 0 ? span : 0);
          yy = base + (reduced ? 0 : dir * P * speed * pitch);
        }
        write(col, '--y', `${Math.round(yy)}px`);
      });
    }
  }

  let ticking = false;
  function schedule() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }

  // The wall's pictures load only when the band comes near, and only for columns on screen.
  const wallImages = () => {
    const theme = resolvedTheme();
    wallCols.forEach((col) => {
      if (!col.offsetWidth) return;
      col.querySelectorAll('img').forEach((img) => {
        const src = screenSrc('phone', img.dataset.screen, col.dataset.theme ?? theme);
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      });
    });
  };
  let wallNear = false;
  new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        wallNear = true;
        wallImages();
      }
    },
    { rootMargin: '150% 0px' },
  ).observe(wall);

  document.addEventListener('themechange', () => {
    lastActive = -1;
    // The rooms' screens follow the theme too.
    main.querySelectorAll('[data-screen]').forEach((m) => {
      const [device, name] = m.dataset.screen.split(' ');
      const src = m.tagName === 'VIDEO' ? media.clip(device, name) : media.still(device, name);
      m.dataset.src = src;
      if (m.getAttribute('src')) m.setAttribute('src', src);
    });
    if (wallNear) wallImages();
    schedule();
  });
  darkQuery.addEventListener('change', () => document.dispatchEvent(new Event('themechange')));
  reduceQuery.addEventListener('change', () => {
    reduced = reduceQuery.matches;
    lastActive = -1;
    schedule();
  });
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', measure);
  addEventListener('orientationchange', measure);
  document.fonts?.ready.then(measure);
  addEventListener('load', measure);
  measure();
  update();
  if (!location.hash) playGather(stage, reduced);
  if (wallNear) wallImages();
}

headlineFont();
startInteractions(() => reduced);
if (root.dataset.page === 'story') startStory();
else import('./legal-page.js').then((m) => m.startLegal(root.dataset.page));
