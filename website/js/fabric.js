// The download button, made of cloth: a soft cushion of velvet with a
// download arrow and its words stitched on. Under the pointer the cloth swells
// toward it, a light follows it across the nap, and a press squeezes it in.
// The cloth is an SVG path redrawn around the pointer and lit by an SVG
// filter (folds, grain and a puffed edge come from noise, nothing is an image).
// Blue in the dark theme, ZOOD navy in the light one (css/site.css).
// With Reduce Motion the cloth stays still.
import { clamp } from './motion.js';

const M = 16; // room around the button for the cloth to swell into
const N = 72; // points round the outline
const arrow =
  '<svg class="fabric-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>';
let count = 0;

export function fabricButton(href, label) {
  const id = `fabric-${++count}`;
  return `<a class="button fabric" href="${href}">
    <svg class="fabric-cloth" aria-hidden="true" focusable="false">
      <defs><filter id="${id}" x="-10%" y="-25%" width="120%" height="160%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.05" numOctaves="2" seed="4" result="folds"/>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" result="grain"/>
        <feTurbulence type="fractalNoise" baseFrequency="0.05 0.55" numOctaves="3" seed="7"/>
        <feColorMatrix values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result="nap"/>
        <feGaussianBlur in="SourceAlpha" stdDeviation="12" result="puff"/>
        <feComposite in="folds" in2="puff" operator="arithmetic" k2="0.35" k3="1" result="h0"/>
        <feComposite in="grain" in2="h0" operator="arithmetic" k2="0.015" k3="1" result="height"/>
        <feDiffuseLighting in="height" surfaceScale="8" diffuseConstant="1.1" lighting-color="#fff" result="shade"><feDistantLight azimuth="250" elevation="40"/></feDiffuseLighting>
        <feSpecularLighting in="height" surfaceScale="8" specularConstant="0.5" specularExponent="14" lighting-color="#fff" result="shine"><fePointLight class="fabric-light" x="0" y="0" z="90"/></feSpecularLighting>
        <feComposite in="SourceGraphic" in2="shade" operator="arithmetic" k1="1.2" result="lit"/>
        <feComposite in="lit" in2="nap" operator="arithmetic" k1="0.32" k2="0.86" result="woven"/>
        <feComposite in="shine" in2="SourceAlpha" operator="in" result="sheen"/>
        <feComposite in="woven" in2="sheen" operator="arithmetic" k2="1" k3="0.28" result="cloth"/>
        <feDisplacementMap in="cloth" in2="grain" scale="1.2" xChannelSelector="R" yChannelSelector="G"/>
      </filter></defs>
      <path class="fabric-body" filter="url(#${id})"/>
    </svg>
    <span class="fabric-label">${arrow}<span>${label}</span></span>
  </a>`;
}

// Points round a pill w × h, evenly spaced along its edge, with their normals.
function outline(w, h) {
  const r = h / 2;
  const straight = w - h;
  const total = 2 * straight + 2 * Math.PI * r;
  const pts = [];
  for (let k = 0; k < N; k++) {
    let s = (k / N) * total;
    let x, y, nx, ny;
    if (s < straight) {
      [x, y, nx, ny] = [r + s, 0, 0, -1];
    } else if ((s -= straight) < Math.PI * r) {
      const a = -Math.PI / 2 + s / r;
      [nx, ny] = [Math.cos(a), Math.sin(a)];
      [x, y] = [w - r + r * nx, r + r * ny];
    } else if ((s -= Math.PI * r) < straight) {
      [x, y, nx, ny] = [w - r - s, h, 0, 1];
    } else {
      s -= straight;
      const a = Math.PI / 2 + s / r;
      [nx, ny] = [Math.cos(a), Math.sin(a)];
      [x, y] = [r + r * nx, r + r * ny];
    }
    pts.push({ x: x + M, y: y + M, nx, ny, k });
  }
  return pts;
}

// A closed smooth curve through the points (Catmull-Rom as cubic Béziers).
function smooth(p) {
  const n = p.length;
  const at = (i) => p[(i + n) % n];
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const [a, b, c, e] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${(b[0] + (c[0] - a[0]) / 6).toFixed(1)} ${(b[1] + (c[1] - a[1]) / 6).toFixed(1)} ${(c[0] - (e[0] - b[0]) / 6).toFixed(1)} ${(c[1] - (e[1] - b[1]) / 6).toFixed(1)} ${c[0].toFixed(1)} ${c[1].toFixed(1)}`;
  }
  return `${d}Z`;
}

export function wireFabric(root, reduced) {
  for (const el of root.querySelectorAll('.fabric')) {
    if (el.__fabric) continue;
    el.__fabric = true;
    const svg = el.querySelector('.fabric-cloth');
    const body = el.querySelector('.fabric-body');
    const light = el.querySelector('.fabric-light');
    const label = el.querySelector('.fabric-label');
    let w = 0;
    let h = 0;
    let pts = [];
    // Where the pointer is (target) and where the swell is (spring), in the SVG's units.
    const tgt = { x: 0, y: 0, on: 0, press: 0 };
    const cur = { x: 0, y: 0, on: 0, press: 0, vx: 0, vy: 0, von: 0, vpress: 0 };
    let raf = 0;
    let last = 0;

    const draw = (time) => {
      const sigma = h * 0.85;
      const lift = 9 * cur.on;
      const p = pts.map(({ x, y, nx, ny, k }) => {
        const d2 = (x - cur.x) ** 2 + (y - cur.y) ** 2;
        const swell = lift * Math.exp(-d2 / (2 * sigma * sigma));
        // A slow ripple runs round the cloth while it is touched.
        const ripple = 1.1 * cur.on * Math.sin(k * 0.55 - time * 0.004);
        const squeeze = -3.5 * cur.press;
        const o = swell + ripple + squeeze;
        return [x + nx * o, y + ny * o];
      });
      body.setAttribute('d', smooth(p));
      light.setAttribute('x', (cur.on > 0.01 ? cur.x : M + w * 0.3).toFixed(1));
      light.setAttribute('y', (cur.on > 0.01 ? cur.y - 10 : M - 6).toFixed(1));
      light.setAttribute('z', (90 - 30 * cur.on).toFixed(1));
      const dx = ((cur.x - M - w / 2) / w) * 4 * cur.on;
      const dy = ((cur.y - M - h / 2) / h) * 3 * cur.on;
      label.style.transform = `translate(${dx.toFixed(2)}px, ${(dy + cur.press * 1.5).toFixed(2)}px)`;
    };

    const step = (time) => {
      const dt = Math.min(0.05, (time - (last || time)) / 1000) || 1 / 60;
      last = time;
      // Damped springs: quick to follow, a little give on the way.
      for (const [key, v, k, c] of [
        ['x', 'vx', 170, 18],
        ['y', 'vy', 170, 18],
        ['on', 'von', 120, 16],
        ['press', 'vpress', 420, 22],
      ]) {
        cur[v] += (k * (tgt[key] - cur[key]) - c * cur[v]) * dt;
        cur[key] += cur[v] * dt;
      }
      draw(time);
      const moving =
        tgt.on > 0 ||
        Math.abs(cur.on) > 0.002 ||
        Math.abs(cur.von) > 0.002 ||
        Math.abs(cur.press) > 0.002 ||
        Math.abs(cur.vpress) > 0.002;
      raf = moving ? requestAnimationFrame(step) : 0;
      if (!raf) last = 0;
    };
    const wake = () => {
      if (!raf && !reduced()) raf = requestAnimationFrame(step);
    };

    const size = () => {
      const box = el.getBoundingClientRect();
      if (!box.width) return;
      [w, h] = [box.width, box.height];
      svg.setAttribute('viewBox', `0 0 ${w + 2 * M} ${h + 2 * M}`);
      svg.setAttribute('width', w + 2 * M);
      svg.setAttribute('height', h + 2 * M);
      pts = outline(w, h);
      cur.x = tgt.x = M + w / 2;
      cur.y = tgt.y = M + h / 2;
      draw(0);
    };
    size();
    new ResizeObserver(size).observe(el);

    const aim = (e) => {
      const box = el.getBoundingClientRect();
      tgt.x = M + clamp(e.clientX - box.left, -8, w + 8);
      tgt.y = M + clamp(e.clientY - box.top, -8, h + 8);
    };
    el.addEventListener('pointerenter', (e) => {
      aim(e);
      if (!cur.on) [cur.x, cur.y] = [tgt.x, tgt.y];
      tgt.on = e.pointerType === 'mouse' ? 1 : 0.6;
      wake();
    });
    el.addEventListener('pointermove', (e) => {
      aim(e);
      wake();
    });
    el.addEventListener('pointerleave', () => {
      tgt.on = 0;
      tgt.press = 0;
      wake();
    });
    el.addEventListener('pointerdown', (e) => {
      aim(e);
      tgt.press = 1;
      wake();
    });
    for (const type of ['pointerup', 'pointercancel'])
      el.addEventListener(type, (e) => {
        tgt.press = 0;
        if (e.pointerType !== 'mouse') tgt.on = 0;
        wake();
      });
    el.addEventListener('focus', () => {
      if (el.matches(':focus-visible')) {
        [tgt.x, tgt.y] = [M + w / 2, M + h / 2];
        tgt.on = 0.5;
        wake();
      }
    });
    el.addEventListener('blur', () => {
      tgt.on = 0;
      wake();
    });
  }
}
