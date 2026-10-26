// "Try it here": one line of Arabic the visitor copies two ways, backwards (as
// some PDF readers copy it) and in reading order (as ZOOD does), then pastes
// into the box to see the difference with their own hands. Everything stays
// in the page: the clipboard is written only when a button is pressed.
import { TRY } from './story.js';

const copyIcon =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1"/></svg>';

// The line in reverse, letter by letter: what a reader that copies in drawing
// order puts on the clipboard.
const backwards = (s) => [...s].reverse().join('');

export function tryScene(t, escape) {
  const row = (kind, text, label) => `<div class="try-row try-${kind}">
      <p class="try-label">${escape(t(label))}</p>
      <p class="try-line" lang="ar" dir="rtl">${escape(text)}</p>
      <button type="button" class="try-copy" data-copy="${kind}">${copyIcon}<span>${escape(t(TRY.copy))}</span></button>
    </div>`;
  return `<div class="try glassroom">
    <div class="blob b1" aria-hidden="true"></div><div class="blob b2" aria-hidden="true"></div>
    <div class="try-card glass">
      ${row('bad', backwards(TRY.line), TRY.backwardsLabel)}
      ${row('good', TRY.line, TRY.rightLabel)}
      <label class="try-paste"><span class="sr-only">${escape(t(TRY.pasteLabel))}</span><textarea rows="2" dir="auto" lang="ar" placeholder="${escape(t(TRY.paste))}"></textarea></label>
      <p class="try-status" role="status" aria-live="polite"></p>
    </div>
  </div>`;
}

function wire(scene) {
  const status = scene.querySelector('.try-status');
  scene.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const text = button.dataset.copy === 'good' ? TRY.line : backwards(TRY.line);
    const lang = document.documentElement.lang === 'en' ? 'en' : 'ar';
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = TRY.copied[lang];
      scene.querySelectorAll('.try-copy').forEach((b) => b.classList.toggle('done', b === button));
    } catch {
      // No clipboard (an old browser, or permission refused): select the line instead.
      const line = button.parentElement.querySelector('.try-line');
      const range = document.createRange();
      range.selectNodeContents(line);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      status.textContent = TRY.blocked[lang];
    }
  });
  // What was pasted shows which way it came out.
  const box = scene.querySelector('textarea');
  box.addEventListener('input', () => {
    const v = box.value.trim();
    box.classList.toggle('is-good', v.includes(TRY.line));
    box.classList.toggle('is-bad', v.includes(backwards(TRY.line)));
  });
}

export function tryFrame(el) {
  const scene = el.querySelector('.try');
  if (!scene) return;
  if (!scene.__wired) {
    scene.__wired = true;
    wire(scene);
  }
}
