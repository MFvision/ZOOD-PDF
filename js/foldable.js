// The iPhone Duo page (iphone-duo/), Apple's foldable iPhone: a white gallery with the device as
// the event. The device is drawn here (two halves on a hinge, in CSS 3D), not
// a photograph: it turns and unfolds as the hero scrolls, then shows each
// tool folded (the outer screen, with the iPhone app's screens) or open (the
// inner screen, with the iPad app's). Copy in foldable-copy.js; styles in
// css/foldable.css. Reduce Motion shows it open and still.
import { FOLD } from './foldable-copy.js';
import { footer, lang, t, topBar, urlFor } from './main.js';
import { clamp, ease, span } from './motion.js';
import { foldDevice, setFold } from './fold-device.js';

const root = document.documentElement;
const escape = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
const blue = (s) => escape(t(s)).replace(/\[\[(.*?)\]\]/g, '<span class="fd-blue">$1</span>');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const theme = () => root.dataset.theme ?? (darkQuery.matches ? 'dark' : 'light');
const asset = (path) => new URL(`../assets/${lang}/${path}`, import.meta.url).href;
const clipType = document.createElement('video').canPlayType('video/webm; codecs="vp9"')
  ? 'webm'
  : 'mp4';

// One screen: a still, or a short clip over its still.
function screen(device, name, clip) {
  const base = `${device}/${name}`;
  const still = `<img class="fd-shot" data-base="${base}" alt="" loading="lazy" decoding="async">`;
  return clip
    ? `${still}<video class="fd-shot fd-clip" data-base="${base}" muted loop playsinline preload="none" aria-hidden="true"></video>`
    : still;
}

// Pictures follow the theme; clips load and play only while on screen.
function paintScreens(scope) {
  const th = theme();
  for (const img of scope.querySelectorAll('img.fd-shot'))
    img.src = asset(`${img.dataset.base}-${th}.webp`);
  for (const v of scope.querySelectorAll('video.fd-clip')) {
    const src = asset(`${v.dataset.base}-${th}.${clipType}`);
    if (v.dataset.src !== src) {
      v.dataset.src = src;
      if (v.getAttribute('src')) v.src = src;
    }
  }
}

function watchClips(scope) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const { target: v, isIntersecting } of entries) {
        if (isIntersecting && !reduceQuery.matches && !navigator.connection?.saveData) {
          if (!v.getAttribute('src')) v.src = v.dataset.src;
          v.play()
            .then(() => v.classList.add('on'))
            .catch(() => {});
        } else v.pause();
      }
    },
    { rootMargin: '10% 0px' },
  );
  scope.querySelectorAll('video.fd-clip').forEach((v) => io.observe(v));
}

function page() {
  const cards = FOLD.cards
    .map((c, k) => {
      const device = c.open
        ? foldDevice({
            inner: screen(c.clip[0], c.clip[1], true),
            outer: screen('phone', '01-home'),
          })
        : foldDevice({ inner: screen('tablet', '02-read'), outer: screen('phone', c.still) });
      return `<li class="fd-card${c.open ? ' is-open' : ''}" id="fd-card-${k}" aria-roledescription="${escape(t(FOLD.slide))}" aria-label="${k + 1} / ${FOLD.cards.length}">
        <h3>${blue(c.title)}</h3>
        <div class="fd-card-stage">${device}</div>
      </li>`;
    })
    .join('');
  const dots = FOLD.cards
    .map(
      (_, k) =>
        `<button type="button" class="fd-dot" data-k="${k}" aria-label="${escape(t(FOLD.slide))} ${k + 1}"></button>`,
    )
    .join('');
  const download = `${urlFor(lang)}#download`;
  return `
  <nav class="fd-local" aria-label="${escape(t(FOLD.bar))}">
    <span class="fd-local-name">${escape(t(FOLD.bar))}</span>
    <a class="fd-pill-outline" href="#fd-highlights">${escape(t(FOLD.overview))}</a>
    <a class="fd-pill-blue" href="${download}">${escape(t(FOLD.get))}</a>
  </nav>

  <section class="fd-hero" aria-labelledby="fd-h1">
    <div class="fd-hero-sticky">
      <p class="fd-kicker">${escape(t(FOLD.kicker))}</p>
      <h1 id="fd-h1" class="fd-display">${blue(FOLD.hero)}</h1>
      <p class="fd-lead">${escape(t(FOLD.heroLead))}</p>
      <div class="fd-hero-stage">
        ${foldDevice({ inner: screen('tablet', '02-read', true), outer: screen('phone', '01-home'), label: t(FOLD.title) })}
        <div class="fd-callout">
          <p><strong>${escape(t(FOLD.free))}</strong> <span>${escape(t(FOLD.freeMore))}</span></p>
          <a class="fd-pill-blue" href="${download}">${escape(t(FOLD.get))}</a>
        </div>
      </div>
    </div>
  </section>

  <nav class="fd-anchors" aria-label="${escape(t(FOLD.overview))}"><ul>
    ${FOLD.nav.map((n) => `<li><a href="#${n.id}">${escape(t(n.label))}</a></li>`).join('')}
  </ul></nav>

  <section class="fd-band" id="fd-highlights" aria-labelledby="fd-hl">
    <div class="fd-band-head">
      <h2 id="fd-hl" class="fd-heading">${escape(t(FOLD.highlights))}</h2>
      <a class="fd-link" href="${urlFor(lang)}#inside">${escape(t(FOLD.all))} ›</a>
    </div>
    <ul class="fd-cards" aria-roledescription="carousel" aria-label="${escape(t(FOLD.highlights))}">${cards}</ul>
    <div class="fd-play">
      <button type="button" class="fd-step" data-step="-1" aria-label="${escape(t(FOLD.prev))}">‹</button>
      <div class="fd-dots">${dots}</div>
      <button type="button" class="fd-step" data-step="1" aria-label="${escape(t(FOLD.next))}">›</button>
      <button type="button" class="fd-pause" aria-pressed="false" data-on="${escape(t(FOLD.pause))}" data-off="${escape(t(FOLD.play))}" aria-label="${escape(t(FOLD.pause))}"><span class="fd-pause-icon"></span></button>
    </div>
  </section>

  <section class="fd-story fd-from-end" id="fd-folded" aria-labelledby="fd-folded-h">
    <div class="fd-story-text">
      <p class="fd-story-kicker">${escape(t(FOLD.folded.kicker))}</p>
      <h2 id="fd-folded-h" class="fd-heading">${blue(FOLD.folded.title)}</h2>
      <p>${escape(t(FOLD.folded.body))}</p>
    </div>
    <div class="fd-story-stage" data-mode="folded">${foldDevice({ inner: screen('tablet', '02-read'), outer: screen('phone', '02-read', true) })}</div>
  </section>

  <section class="fd-story" id="fd-open" aria-labelledby="fd-open-h">
    <div class="fd-story-text">
      <p class="fd-story-kicker">${escape(t(FOLD.open.kicker))}</p>
      <h2 id="fd-open-h" class="fd-heading">${blue(FOLD.open.title)}</h2>
      <p>${escape(t(FOLD.open.body))}</p>
    </div>
    <div class="fd-story-stage" data-mode="open">${foldDevice({ inner: screen('tablet', '05-comment', true), outer: screen('phone', '01-home') })}</div>
  </section>

  <section class="fd-band fd-private" id="fd-private" aria-labelledby="fd-private-h">
    <p class="fd-story-kicker">${escape(t(FOLD.private.kicker))}</p>
    <h2 id="fd-private-h" class="fd-heading">${blue(FOLD.private.title)}</h2>
    <ul class="fd-points">${FOLD.private.points.map((p) => `<li>${escape(t(p))}</li>`).join('')}</ul>
  </section>

  <section class="fd-closing" aria-labelledby="fd-close-h">
    <h2 id="fd-close-h" class="fd-display fd-display-s">${blue(FOLD.closing)}</h2>
    <div class="fd-closing-actions">
      <a class="fd-pill-blue fd-pill-l" href="${download}">${escape(t(FOLD.get))}</a>
      <a class="fd-link" href="${urlFor(lang)}">${escape(t(FOLD.home))} ›</a>
    </div>
  </section>`;
}

// The carousel: slides by scroll-snap; the dots, arrows and pause sit in one pill.
function wireCarousel(band, reduced) {
  const list = band.querySelector('.fd-cards');
  const cards = [...list.children];
  const dots = [...band.querySelectorAll('.fd-dot')];
  const pause = band.querySelector('.fd-pause');
  let current = 0;
  let paused = false;
  let visible = false;
  let timer = 0;
  const go = (k, smooth = true) => {
    current = (k + cards.length) % cards.length;
    const card = cards[current];
    const rtl = getComputedStyle(list).direction === 'rtl';
    const left = rtl
      ? card.offsetLeft + card.offsetWidth - list.clientWidth
      : card.offsetLeft - (list.clientWidth - card.offsetWidth) / 2;
    list.scrollTo({ left, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
  };
  const mark = () => {
    const mid = list.getBoundingClientRect().left + list.clientWidth / 2;
    let best = 0;
    let d = Infinity;
    cards.forEach((c, k) => {
      const r = c.getBoundingClientRect();
      const dd = Math.abs(r.left + r.width / 2 - mid);
      if (dd < d) [d, best] = [dd, k];
    });
    current = best;
    dots.forEach((dot, k) => dot.setAttribute('aria-current', String(k === best)));
    cards.forEach((c, k) => c.classList.toggle('is-here', k === best));
  };
  const tick = () => {
    clearTimeout(timer);
    if (!paused && visible && !reduced()) timer = setTimeout(() => go(current + 1), 5000);
  };
  list.addEventListener('scroll', () => {
    requestAnimationFrame(mark);
    tick();
  });
  dots.forEach((dot) => dot.addEventListener('click', () => go(+dot.dataset.k)));
  band
    .querySelectorAll('.fd-step')
    .forEach((b) => b.addEventListener('click', () => go(current + Number(b.dataset.step))));
  pause.addEventListener('click', () => {
    paused = !paused;
    pause.setAttribute('aria-pressed', String(paused));
    pause.setAttribute('aria-label', paused ? pause.dataset.off : pause.dataset.on);
    tick();
  });
  // Someone reading a slide stops the advance.
  list.addEventListener('pointerdown', () => {
    paused = true;
    pause.setAttribute('aria-pressed', 'true');
    pause.setAttribute('aria-label', pause.dataset.off);
    clearTimeout(timer);
  });
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    tick();
  }).observe(list);
  mark();
}

export function startFoldable() {
  root.classList.add('fd-page');
  const main = document.createElement('main');
  main.id = 'main';
  main.className = 'fd';
  main.innerHTML = page();
  const skip = document.createElement('a');
  skip.className = 'skip';
  skip.href = '#main';
  skip.textContent = lang === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content';
  document.body.prepend(skip, topBar('iphone-duo'), main);
  document.body.append(footer());
  paintScreens(main);
  watchClips(main);
  document.addEventListener('themechange', () => paintScreens(main));
  darkQuery.addEventListener('change', () => paintScreens(main));

  const reduced = () => reduceQuery.matches;
  wireCarousel(main.querySelector('.fd-band'), reduced);

  const hero = main.querySelector('.fd-hero');
  const heroDevice = hero.querySelector('.fd-device');
  const heroText = hero.querySelectorAll('.fd-kicker, .fd-display, .fd-lead');
  const callout = hero.querySelector('.fd-callout');
  const stories = [...main.querySelectorAll('.fd-story')];
  const cards = [...main.querySelectorAll('.fd-card')];
  cards.forEach((c) =>
    setFold(c.querySelector('.fd-device'), c.classList.contains('is-open') ? 0 : 1, -14, 4),
  );

  let queued = false;
  const update = () => {
    queued = false;
    const vh = innerHeight;
    if (reduced()) {
      setFold(heroDevice, 0);
      heroDevice.style.scale = '';
      heroDevice.style.translate = '';
      heroText.forEach((el) => (el.style.opacity = ''));
      callout.style.opacity = '1';
      stories.forEach((s) => {
        const d = s.querySelector('.fd-device');
        setFold(d, s.querySelector('[data-mode="folded"]') ? 1 : 0);
        d.style.translate = '';
      });
      return;
    }
    // Hero: it arrives folded and turned, faces you, then opens.
    const r = hero.getBoundingClientRect();
    const p = clamp(-r.top / Math.max(1, r.height - vh));
    const face = ease(span(p, 0, 0.35));
    const open = ease(span(p, 0.4, 0.85));
    setFold(heroDevice, 1 - open, (1 - face) * -32, (1 - face) * 10);
    // Small and low under the words at first; the whole stage once open.
    const grow = ease(span(p, 0.35, 0.9));
    const stageH = hero.firstElementChild.clientHeight;
    // Folded, the outer screen fills about half the stage's height.
    const start = clamp((stageH * 0.48) / (heroDevice.offsetWidth * 0.704), 0.5, 1.2);
    heroDevice.style.scale = (start + (1 - start) * grow).toFixed(4);
    heroDevice.style.translate = `0 ${((1 - grow) * stageH * 0.24).toFixed(1)}px`;
    const words = 1 - ease(span(p, 0.28, 0.55));
    heroText.forEach((el) => {
      el.style.opacity = words.toFixed(3);
      el.style.translate = `0 ${((1 - words) * -40).toFixed(1)}px`;
    });
    callout.style.opacity = ease(span(p, 0.85, 0.97)).toFixed(3);
    callout.style.translate = `0 ${((1 - ease(span(p, 0.85, 0.97))) * 24).toFixed(1)}px`;
    // Stories: the device slides in from the far side; the open one unfolds as it comes.
    for (const s of stories) {
      const box = s.getBoundingClientRect();
      const q = clamp((vh - box.top) / (vh * 0.9));
      const d = s.querySelector('.fd-device');
      const folded = !!s.querySelector('[data-mode="folded"]');
      const side =
        (getComputedStyle(s).direction === 'rtl' ? -1 : 1) *
        (s.classList.contains('fd-from-end') ? 1 : -1);
      d.style.translate = `${((1 - ease(q)) * side * 30).toFixed(2)}vw 0`;
      setFold(d, folded ? 1 : 1 - ease(span(q, 0.35, 1)), (1 - ease(q)) * side * -24, 0);
    }
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  };
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  reduceQuery.addEventListener('change', schedule);
  update();
}
