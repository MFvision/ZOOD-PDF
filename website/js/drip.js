// The ZOOD pattern, running down the page like paint. Each narrow column of
// the pattern is revealed from the top at its own speed (slow neighbours, a
// few quick runs), so the paint edge drips rather than moves as one line. The
// paint runs while a chapter plays and slides down off the page as the next
// one begins. With Reduce Motion the pattern simply stands, as before.
const NS = 'http://www.w3.org/2000/svg';
const COL = 14; // column width in CSS px
const TILE = [507.39, 1044.2]; // the pattern's own size

// Smooth noise in 0-1 from a few sines, so neighbouring columns run alike.
const noise = (i) =>
  0.5 +
  0.22 * Math.sin(i * 0.37 + 1.3) +
  0.16 * Math.sin(i * 0.91 + 4.1) +
  0.12 * Math.sin(i * 2.3 + 0.7);

export function startDrip(el, patternUrl) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('drip');
  const id = `drip-${Math.random().toString(36).slice(2, 8)}`;
  svg.innerHTML = `<defs><mask id="${id}" maskUnits="userSpaceOnUse"><g class="drip-paint" fill="#fff"></g></mask></defs><g class="drip-pattern" mask="url(#${id})"></g>`;
  el.append(svg);
  const paint = svg.querySelector('.drip-paint');
  const pattern = svg.querySelector('.drip-pattern');
  let w = 0;
  let h = 0;
  let cols = [];
  let path = '';

  fetch(patternUrl)
    .then((r) => (r.ok ? r.text() : ''))
    .then((text) => {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      path = [...doc.querySelectorAll('path')]
        .map((p) => p.getAttribute('d') ?? '')
        .filter((d) => /^[\d\s.,eEMLCZHVSQTAmlczhvsqta-]+$/.test(d))
        .join(' ');
      layout();
    })
    .catch(() => {});

  function layout() {
    const box = el.getBoundingClientRect();
    w = Math.max(1, Math.round(box.width));
    h = Math.max(1, Math.round(box.height));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    // The pattern, as tall as the element and repeated sideways.
    const scale = h / TILE[1];
    const tw = TILE[0] * scale;
    pattern.replaceChildren();
    for (let x = 0; x < w + tw; x += tw) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', path);
      p.setAttribute('transform', `translate(${x.toFixed(1)} 0) scale(${scale.toFixed(5)})`);
      pattern.append(p);
    }
    // One column of paint per strip: a bar with a rounded drop at its end.
    paint.replaceChildren();
    cols = [];
    const n = Math.ceil(w / COL);
    for (let i = 0; i < n; i++) {
      const g = document.createElementNS(NS, 'g');
      const bar = document.createElementNS(NS, 'rect');
      const drop = document.createElementNS(NS, 'circle');
      bar.setAttribute('x', String(i * COL - 0.5));
      bar.setAttribute('width', String(COL + 1));
      drop.setAttribute('cx', String(i * COL + COL / 2));
      drop.setAttribute('r', String(COL * 0.62));
      g.append(bar, drop);
      paint.append(g);
      const r = noise(i);
      // Most columns run at a steady pace; one in a few runs ahead.
      const speed = 0.55 + r * 0.9 + (r > 0.78 ? 0.45 : 0);
      cols.push({ bar, drop, speed, last: -1 });
    }
    last = null;
  }

  let last = null;
  /** progress: 0-1 through the chapter; away: 0-1 as the paint leaves; full: stand still. */
  function set(progress, away, full) {
    if (!cols.length) return;
    const key = `${progress.toFixed(3)}|${away.toFixed(3)}|${full}`;
    if (key === last) return;
    last = key;
    paint.setAttribute('transform', full ? '' : `translate(0 ${(away * h).toFixed(1)})`);
    for (const c of cols) {
      const len = full ? h + COL : Math.min(1, progress * 1.3 * c.speed) * (h + COL);
      const v = Math.round(len);
      if (v === c.last) continue;
      c.last = v;
      c.bar.setAttribute('y', '0');
      c.bar.setAttribute('height', String(Math.max(0, v - COL * 0.5)));
      c.drop.setAttribute('cy', String(Math.max(-COL, v - COL * 0.5)));
    }
  }

  return { set, layout };
}
