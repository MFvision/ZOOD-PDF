// The opening: loose papers scattered across the screen drift in, straighten
// and settle onto the desk's stack, which then wears the ZOOD PDF mark. Plays
// once, at load, only at the top of the page; with Reduce Motion the page
// opens on the finished stack.
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

// Where each paper starts: a fraction of the viewport, a turn and a tilt.
// Fixed, so the opening looks the same every time.
const START = [
  [0.08, 0.18, -24, 18],
  [0.3, 0.06, 16, -14],
  [0.62, 0.12, -10, 22],
  [0.9, 0.22, 28, -20],
  [0.04, 0.62, 12, -16],
  [0.94, 0.66, -20, 14],
  [0.22, 0.9, -32, 20],
  [0.55, 0.94, 22, -18],
  [0.8, 0.88, -14, 16],
];

export function playGather(stage, reduced) {
  const desk = stage.querySelector('.desk');
  const top = stage.querySelector('.sheet.top');
  const badge = document.createElement('div');
  badge.className = 'gather-badge';
  badge.innerHTML = '<span class="gather-mark"></span><span>PDF</span>';
  stage.querySelector('.desk-move').append(badge);
  // The mark leaves as the reader scrolls into the story.
  const fade = () => badge.classList.toggle('away', scrollY > 40);
  addEventListener('scroll', fade, { passive: true });

  const box = top.getBoundingClientRect();
  if (reduced || scrollY > 50 || !box.width || !Element.prototype.animate) {
    fade();
    badge.classList.add('on');
    return;
  }

  const layer = document.createElement('div');
  layer.className = 'gather';
  layer.setAttribute('aria-hidden', 'true');
  const papers = START.map((_, i) => {
    const p = document.createElement('div');
    p.className = 'gather-paper';
    p.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;--n:${i}`;
    layer.append(p);
    return p;
  });
  stage.after(layer);
  desk.classList.add('gathering');

  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const settle = papers.map((p, i) => {
    const [fx, fy, turn, tilt] = START[i];
    const dx = fx * innerWidth - cx;
    const dy = fy * innerHeight - cy;
    // Each lands a hair off square, so the stack reads as paper.
    const end = `translate(${(i % 3) - 1}px, ${-i * 0.6}px) rotate(${((i % 4) - 1.5) * 0.7}deg)`;
    return p.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px) rotate(${turn}deg) rotateX(${tilt}deg) scale(0.62)`,
          opacity: 0,
        },
        { opacity: 1, offset: 0.15 },
        { transform: end, opacity: 1 },
      ],
      { duration: 1500, delay: 120 + i * 90, easing: EASE, fill: 'both' },
    ).finished;
  });

  Promise.all(settle)
    .then(() => {
      desk.classList.remove('gathering');
      badge.classList.add('on');
      fade();
      return layer.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 420,
        easing: 'ease-out',
        fill: 'forwards',
      }).finished;
    })
    .catch(() => {
      desk.classList.remove('gathering');
      badge.classList.add('on');
    })
    .finally(() => layer.remove());
}
