// Touch feedback: a ring of light spreads from the point where a control is
// pressed (css/site.css has the press and spring of the control itself).
// Skipped with Reduce Motion.
// The cloth button (fabric.js) answers a press with its own squeeze.
const SELECTOR = '.button:not(.fabric), .switch a, .switch button, .downloads a';

export function startInteractions(reduced) {
  addEventListener(
    'pointerdown',
    (e) => {
      if (reduced() || !Element.prototype.animate) return;
      const el = e.target.closest?.(SELECTOR);
      if (!el) return;
      const box = el.getBoundingClientRect();
      const tap = document.createElement('span');
      tap.className = 'tap';
      tap.style.left = `${e.clientX - box.left}px`;
      tap.style.top = `${e.clientY - box.top}px`;
      el.append(tap);
      const size = (Math.hypot(box.width, box.height) / 12) * 2.2;
      tap
        .animate(
          [
            { transform: 'scale(0)', opacity: 1 },
            { transform: `scale(${size})`, opacity: 0 },
          ],
          { duration: 620, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        )
        .finished.catch(() => {})
        .finally(() => tap.remove());
    },
    { passive: true },
  );
}
