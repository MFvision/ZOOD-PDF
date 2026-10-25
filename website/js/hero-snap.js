// The opening line arrives the way a broken PDF reader shows Arabic, its words
// in reverse order, and then snaps into reading order while the papers settle.
// Whole words move, never letters, so Arabic stays joined. Only `translate` is
// animated, which composes with the words' own rise-in (css/site.css).
// With Reduce Motion, or when the page opens on a chapter, it is not played.
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

export async function snapTitle(title, skip) {
  if (!title || skip || !Element.prototype.animate) return;
  const words = [...title.querySelectorAll('.w')];
  if (words.length < 3) return;
  // The words wait, unseen, for the fonts, so they are measured where they will sit.
  title.classList.add('snap-wait');
  const started = performance.now();
  await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1200))]);
  const late = Math.max(0, performance.now() - started);
  const boxes = words.map((w) => w.getBoundingClientRect());
  // Lines, by where each word sits; each line starts in reverse order.
  const lines = [];
  boxes.forEach((b, i) => {
    const line = lines.find((l) => Math.abs(boxes[l[0]].top - b.top) < b.height / 2);
    if (line) line.push(i);
    else lines.push([i]);
  });
  for (const line of lines) {
    if (line.length < 2) continue;
    // The line as drawn, left to right, and the same words packed in the
    // opposite order with the same gaps: that is the line read backwards.
    const drawn = [...line].sort((x, y) => boxes[x].left - boxes[y].left);
    const left = boxes[drawn[0]].left;
    const right = Math.max(...line.map((i) => boxes[i].right));
    const widths = line.reduce((sum, i) => sum + boxes[i].width, 0);
    const gap = (right - left - widths) / (line.length - 1);
    let x = left;
    drawn.reverse().forEach((i, k) => {
      const dx = x - boxes[i].left;
      x += boxes[i].width + gap;
      if (Math.abs(dx) < 1) return;
      // Over when moving one way, under when moving the other, so swapped
      // words never collide on the way home.
      const lift = dx > 0 ? -0.5 : 0.5;
      words[i].animate(
        [
          { translate: `${dx}px 0` },
          { translate: `${dx / 2}px ${lift}em`, offset: 0.5 },
          { translate: '0 0' },
        ],
        {
          duration: 1000,
          delay: Math.max(300, 1100 - late) + k * 60,
          easing: EASE,
          fill: 'backwards',
        },
      );
    });
  }
  title.classList.remove('snap-wait');
}
