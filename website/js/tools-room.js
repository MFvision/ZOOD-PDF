// The tools chapter: one tab per tool over a large desktop window playing that
// tool's own recording. The scroll steps through the tabs until the visitor
// picks one; then the choice is theirs. Arrow keys move between tabs.
import { TOOL_TABS } from './story.js';
import { setter } from './motion.js';

export function toolsScene(t, escape, media) {
  const [w, h] = media.size('desktop');
  const tabs = TOOL_TABS.map(
    (tab, k) =>
      `<button type="button" role="tab" id="tool-tab-${k}" class="tk-tab" data-k="${k}" aria-selected="${k === 0}" aria-controls="tool-panel" tabindex="${k === 0 ? 0 : -1}">${escape(t(tab.name))}</button>`,
  ).join('');
  const first = TOOL_TABS[0];
  return `<div class="tk glassroom">
    <div class="blob b1" aria-hidden="true"></div><div class="blob b3" aria-hidden="true"></div>
    <div class="tk-tabs glass" role="tablist">${tabs}<span class="tk-pill" aria-hidden="true"></span></div>
    <div class="tk-panel" id="tool-panel" role="tabpanel" aria-labelledby="tool-tab-0">
      <div class="tk-device" aria-hidden="true"><div class="win-strip"></div><div class="screen">
        <img alt="" width="${w}" height="${h}" decoding="async" data-screen="desktop ${first.screen}" data-src="${escape(media.still('desktop', first.screen))}">
        <video muted loop playsinline disablepictureinpicture preload="none" width="${w}" height="${h}" data-screen="desktop ${first.screen}" data-src="${escape(media.clip('desktop', first.screen))}"></video>
      </div></div>
      <div class="tk-caption glass"><h3>${escape(t(first.title))}</h3><p>${escape(t(first.text))}</p></div>
    </div>
  </div>`;
}

function show(scene, k, media, t, focus) {
  if (scene.__k === k) return;
  scene.__k = k;
  const tab = TOOL_TABS[k];
  const tabs = [...scene.querySelectorAll('.tk-tab')];
  tabs.forEach((b, j) => {
    b.setAttribute('aria-selected', String(j === k));
    b.tabIndex = j === k ? 0 : -1;
  });
  if (focus) tabs[k].focus();
  scene.querySelector('.tk-panel').setAttribute('aria-labelledby', `tool-tab-${k}`);
  const active = tabs[k];
  const set = (scene.__set ??= setter(scene));
  set('--pill-x', `${active.offsetLeft}px`);
  set('--pill-w', `${active.offsetWidth}px`);
  const caption = scene.querySelector('.tk-caption');
  caption.querySelector('h3').textContent = t(tab.title);
  caption.querySelector('p').textContent = t(tab.text);
  caption.classList.remove('swap');
  void caption.offsetWidth;
  caption.classList.add('swap');
  const img = scene.querySelector('.tk-device img');
  const video = scene.querySelector('.tk-device video');
  img.dataset.screen = video.dataset.screen = `desktop ${tab.screen}`;
  img.dataset.src = media.still('desktop', tab.screen);
  img.src = img.dataset.src;
  video.classList.remove('on');
  video.dataset.src = media.clip('desktop', tab.screen);
  if (video.dataset.src) {
    video.src = video.dataset.src;
    video.addEventListener('playing', () => video.classList.add('on'), { once: true });
    video.play().catch(() => {});
  } else video.removeAttribute('src');
}

export function toolsFrame(media, t) {
  return (el, p, reduced) => {
    const scene = el.querySelector('.tk');
    if (!scene) return;
    if (!scene.__wired) {
      scene.__wired = true;
      const tabs = scene.querySelector('.tk-tabs');
      tabs.addEventListener('click', (event) => {
        const b = event.target.closest('.tk-tab');
        if (!b) return;
        scene.__picked = true;
        show(scene, Number(b.dataset.k), media, t);
      });
      tabs.addEventListener('keydown', (event) => {
        const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
        let step = keys[event.key];
        if (step === undefined) return;
        event.preventDefault();
        const n = TOOL_TABS.length;
        const rtl = getComputedStyle(tabs).direction === 'rtl';
        if (typeof step === 'number' && rtl) step = -step;
        const k =
          step === 'first'
            ? 0
            : step === 'last'
              ? n - 1
              : ((((scene.__k ?? 0) + step) % n) + n) % n;
        scene.__picked = true;
        show(scene, k, media, t, true);
      });
      scene.__k = -1;
      show(scene, 0, media, t);
    }
    // Until the visitor picks a tab, the scroll walks through them.
    // (Not on phones, where the chapter is not pinned and simply scrolls by.)
    if (!scene.__picked && !reduced && el.offsetHeight > innerHeight * 1.5) {
      const k = Math.min(TOOL_TABS.length - 1, Math.floor(p * TOOL_TABS.length));
      show(scene, k, media, t);
    }
    // It plays only while the chapter is on screen.
    const video = scene.querySelector('.tk-device video');
    const here = p > 0 && p < 1;
    if (!here && !video.paused) video.pause();
    else if (here && video.src && video.paused && !document.hidden) video.play().catch(() => {});
  };
}
