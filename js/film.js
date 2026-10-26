// The film: the app in thirty seconds (made by tools/promo/make.mjs from the
// app's own screens, with music made there too). It plays without sound while
// its room is on screen and pauses when it leaves; a button turns the sound
// on, and the player's own controls are there. With Reduce Motion or Save
// Data it waits on its poster until someone presses play. Narrow screens get
// the 720p copy (about a third of the size).
const WORDS = {
  label: { ar: 'فيلم قصير عن التطبيق', en: 'A short film of the app' },
  soundOn: { ar: 'شغّل الصوت', en: 'Sound on' },
  soundOff: { ar: 'أوقف الصوت', en: 'Sound off' },
};
const speaker =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path class="on" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/><path class="off" d="m16 9 5 6M21 9l-5 6"/></svg>';

export function filmScene(t, escape, lang) {
  const base = new URL(`../assets/film/film-${lang}`, import.meta.url).href;
  return `<div class="film">
    <video class="film-video" controls muted playsinline preload="none" width="1920" height="1080" poster="${base}.webp" aria-label="${escape(t(WORDS.label))}">
      <source src="${base}-720.webm" type="video/webm" media="(max-width: 760px)">
      <source src="${base}-720.mp4" type="video/mp4" media="(max-width: 760px)">
      <source src="${base}.webm" type="video/webm">
      <source src="${base}.mp4" type="video/mp4">
    </video>
    <button type="button" class="film-sound glass" data-on="${escape(t(WORDS.soundOff))}" data-off="${escape(t(WORDS.soundOn))}">${speaker}<span>${escape(t(WORDS.soundOn))}</span></button>
  </div>`;
}

export function filmFrame(el, p, reduced) {
  const video = el.querySelector('.film-video');
  if (!video) return;
  if (!el.__wired) {
    el.__wired = true;
    const button = el.querySelector('.film-sound');
    const show = () => {
      button.classList.toggle('on', !video.muted);
      button.querySelector('span').textContent = video.muted
        ? button.dataset.off
        : button.dataset.on;
    };
    button.addEventListener('click', () => {
      video.muted = !video.muted;
      // Sound on starts it from the top, so the music is heard from its first note.
      if (!video.muted && video.currentTime > 1 && !el.__heard) video.currentTime = 0;
      el.__heard = true;
      video.play().catch(() => {});
      show();
    });
    video.addEventListener('volumechange', show);
  }
  // Someone who pauses it keeps it paused until they play it again.
  if (!el.__pauseWatch) {
    el.__pauseWatch = true;
    video.addEventListener('pause', () => {
      if (el.__inView) el.__stopped = true;
    });
    video.addEventListener('play', () => (el.__stopped = false));
  }
  const auto = !reduced && !navigator.connection?.saveData;
  const on = p > 0 && p < 1;
  el.__inView = on;
  if (on && auto && video.paused && !el.__stopped) video.play().catch(() => {});
  if (!on && !video.paused) video.pause();
}
