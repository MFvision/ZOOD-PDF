// Small helpers the scroll-played rooms share.
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** Where p is between s and e, as 0-1. */
export const span = (p, s, e) => clamp((p - s) / (e - s));
export const ease = (x) => 1 - (1 - x) ** 3;
/** A soft overshoot, for things that land like a drop. */
export const spring = (x) => (x >= 1 ? 1 : 1 - Math.cos(x * Math.PI * 1.5) * (1 - x) ** 1.6);
export const mix = (a, b, k) => a + (b - a) * k;

/** Writes CSS custom properties on an element, numbers rounded. */
export function setter(el) {
  const last = new Map();
  return (name, v) => {
    const value = typeof v === 'number' ? v.toFixed(3) : v;
    if (last.get(name) === value) return;
    last.set(name, value);
    el.style.setProperty(name, value);
  };
}

/** With Reduce Motion a room steps between a few still states instead of gliding. */
export const stepped = (p, steps) => steps.find((s) => p <= s + 0.08) ?? steps.at(-1);
