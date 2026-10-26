// The AI room: a glass card floats in, the question is typed and sent, and
// the answer fans out into cards, each naming the page it came from. Then the
// real app takes over on a screen beside them, playing its own recording.
// The answer is the one the screen recording shows (tools/capture-screens.mjs).
import { clamp, ease, mix, setter, span, spring, stepped } from './motion.js';

const WORDS = {
  ask: { ar: 'لخّص هذا التقرير', en: 'Summarize this report' },
  hint: { ar: 'اسأل عن هذا الملف…', en: 'Ask about this file…' },
  send: { ar: 'إرسال', en: 'Send' },
  local: { ar: 'على جهازك', en: 'On your device' },
  page: { ar: 'ص', en: 'p.' },
  answers: {
    ar: [
      'تقرير الربع الثالث لشركة وهمية.',
      'الطلبات المكتملة ارتفعت عن الربع السابق.',
      'زمن الاستجابة انخفض، وتأخر قليل منها لنقص المرفقات.',
      'الخطوة القادمة: تحويل الأرشيف الورقي إلى ملفات قابلة للبحث.',
    ],
    en: [
      'The third-quarter report of a made-up company.',
      'Completed requests rose against the previous quarter.',
      'Response times fell; a few waited on missing attachments.',
      'Next: turning the paper archive into searchable files.',
    ],
  },
};

const sparkle =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5 4.6-.6 6.9-2.9 7.5-7.5Z"/><path d="M19 15.5c.25 1.9 1.1 2.75 3 3-1.9.25-2.75 1.1-3 3-.25-1.9-1.1-2.75-3-3 1.9-.25 2.75-1.1 3-3Z"/></svg>';

export function aiScene(t, escape, media) {
  const answers = t(WORDS.answers)
    .map(
      (line, k) =>
        `<div class="ai-ans" style="--k:${k}"><span class="ai-dot"></span><p>${escape(line)}</p><span class="ai-pg">${escape(t(WORDS.page))} 1</span></div>`,
    )
    .join('');
  const [w, h] = media.size('desktop');
  return `<div class="ai glassroom" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="ai-space"><div class="ai-tilt">
      <div class="ai-answers">${answers}</div>
      <div class="ai-prompt glass">
        <div class="ai-field"><span class="ai-spark">${sparkle}</span><span class="ai-typed" data-text="${escape(t(WORDS.ask))}"></span><span class="ai-hint">${escape(t(WORDS.hint))}</span><span class="ai-caret"></span></div>
        <div class="ai-row"><span class="ai-local"><i></i>${escape(t(WORDS.local))}</span><span class="ai-send"><b>↑</b> ${escape(t(WORDS.send))}<span class="ai-ripple"></span></span></div>
      </div>
    </div></div>
    <div class="ai-device"><div class="win-strip"></div><div class="screen"><img alt="" width="${w}" height="${h}" decoding="async" data-screen="desktop ai" data-src="${escape(media.still('desktop', 'ai'))}"><video muted loop playsinline disablepictureinpicture preload="none" width="${w}" height="${h}" data-screen="desktop ai" data-src="${escape(media.clip('desktop', 'ai'))}"></video></div></div>
  </div>`;
}

export function aiFrame(el, p, reduced) {
  const scene = el.querySelector('.ai');
  if (!scene) return;
  if (reduced) p = stepped(p, [0.04, 0.3, 0.5, 0.92]);
  const set = (scene.__set ??= setter(scene));

  set('--in', ease(span(p, 0, 0.08)));
  // The question, typed letter by letter.
  const typed = scene.querySelector('.ai-typed');
  const text = typed.dataset.text;
  const n = Math.round(text.length * span(p, 0.08, 0.26));
  const shown = [...text].slice(0, n).join('');
  if (typed.textContent !== shown) typed.textContent = shown;
  scene.classList.toggle('ai-has-text', n > 0);
  // Send: pressed in, then let go, with a ring of light.
  const press = span(p, 0.27, 0.3) * (1 - span(p, 0.3, 0.33));
  set('--press', press);
  set('--ripple', span(p, 0.3, 0.4));
  // The answer fans out under the card, one line after another.
  scene.querySelectorAll('.ai-ans').forEach((card, k) => {
    const a = span(p, 0.36 + k * 0.05, 0.5 + k * 0.05);
    card.style.setProperty('--a', spring(a).toFixed(3));
    card.style.setProperty('--o', clamp(a * 3).toFixed(3));
  });
  // The room steps back and the app takes over beside it.
  const away = ease(span(p, 0.64, 0.82));
  set('--away', away);
  set('--dev', ease(span(p, 0.68, 0.86)));
  set('--drift', mix(0, 1, p));
  playDevice(scene, p >= 0.62 && !reduced, p >= 0.62);
}

// The recording loads only when the screen comes in, and pauses when it leaves.
function playDevice(scene, play, show) {
  const img = scene.querySelector('.ai-device img');
  const video = scene.querySelector('.ai-device video');
  if (show && !img.getAttribute('src')) img.setAttribute('src', img.dataset.src);
  if (play) {
    if (!video.getAttribute('src')) {
      video.setAttribute('src', video.dataset.src);
      video.addEventListener('playing', () => video.classList.add('on'), { once: true });
    }
    if (video.paused) video.play().catch(() => {});
  } else if (!video.paused) video.pause();
}
