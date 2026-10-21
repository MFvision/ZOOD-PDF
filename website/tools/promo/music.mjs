// The film's music, made here from plain waves so nothing is licensed from
// anyone: 120 beats a minute, C, G, A minor, F, a bar each; a soft pad and a
// plucked arpeggio from the start, drums and bass when the ring opens,
// a whoosh into every cut, one hit for the closing name, then it rings out.
// writeMusic(path) writes a 44.1 kHz 16-bit stereo WAV of the film's length.
import { writeFileSync } from 'node:fs';

const RATE = 44100;
const LENGTH = 30;
const BEAT = 0.5;
const N = RATE * LENGTH;
// Scene cuts (promo.js) and the closing name.
const CUTS = [2.5, 6.5, 9.5, 13, 15.5, 19, 22, 25.5];
const NAME = 27.65;

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
// Root (bass) and chord tones, one bar (four beats) each.
const BARS = [
  [48, [60, 64, 67, 71]], // C maj7
  [43, [59, 62, 67, 71]], // G
  [45, [57, 60, 64, 67]], // A minor 7
  [41, [57, 60, 65, 69]], // F maj7
];
const barAt = (t) => BARS[Math.floor(t / (4 * BEAT)) % 4];

// A seeded noise, so the file is the same on every build.
let seed = 7;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
};

function makeMusic() {
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const add = (i, l, r = l) => {
    if (i >= 0 && i < N) {
      L[i] += l;
      R[i] += r;
    }
  };

  // Pad: four detuned saws per chord tone through a gentle low-pass, swelling in.
  let lp = [0, 0];
  for (let i = 0; i < N; i++) {
    const t = i / RATE;
    const [, tones] = barAt(t);
    let v = 0;
    for (const m of tones)
      for (const d of [-0.07, 0.07]) {
        const f = hz(m - 12) * 2 ** (d / 12);
        v += ((t * f) % 1) * 2 - 1;
      }
    const cutoff = 0.02 + 0.03 * Math.min(1, t / 3);
    lp[0] += cutoff * (v - lp[0]);
    lp[1] += cutoff * (lp[0] - lp[1]);
    const swell = Math.min(1, t / 2.5) * (t > NAME ? Math.max(0, 1 - (t - NAME) / 2.8) * 1.4 : 1);
    add(i, lp[1] * 0.035 * swell);
  }
  // The closing chord, held and fading.
  for (let i = Math.floor(NAME * RATE); i < N; i++) {
    const t = i / RATE - NAME;
    let v = 0;
    for (const m of [48, 55, 60, 64, 67, 72])
      v += Math.sin(2 * Math.PI * hz(m) * t) * (1 / (1 + m / 60));
    add(i, v * 0.05 * Math.min(1, t / 0.05) * Math.exp(-t / 1.6));
  }

  // Pluck: an eighth-note arpeggio, each note a bright decaying tone, echoed.
  const pluck = (start, f, amp, pan) => {
    const len = Math.floor(0.6 * RATE);
    const i0 = Math.floor(start * RATE);
    for (let k = 0; k < len; k++) {
      const t = k / RATE;
      const env = Math.exp(-t * 9) * Math.min(1, t / 0.003);
      const v =
        (Math.sin(2 * Math.PI * f * t) +
          0.35 * Math.sin(4 * Math.PI * f * t) +
          0.12 * Math.sin(6 * Math.PI * f * t)) *
        env *
        amp;
      add(i0 + k, v * (1 - pan), v * (1 + pan));
    }
  };
  const order = [0, 1, 2, 3, 2, 1, 2, 3];
  for (let s = 0.5; s < NAME; s += BEAT / 2) {
    const [, tones] = barAt(s);
    const step = Math.round(s / (BEAT / 2)) % 8;
    const m = tones[order[step]] + (step >= 4 && s > 14 ? 12 : 0);
    const amp = s < 3 ? 0.07 : 0.1;
    const pan = step % 2 ? 0.3 : -0.3;
    pluck(s, hz(m), amp, pan);
    pluck(s + 0.375, hz(m), amp * 0.35, -pan); // the echo, a dotted eighth later
  }

  // Drums and bass from the first cut to the closing name; a short break
  // before the remote and before the close.
  const groove = (t) => t >= 2.5 && t < NAME && !(t >= 21.5 && t < 22) && !(t >= 25 && t < 25.5);
  for (let b = 2.5; b < NAME; b += BEAT) {
    if (!groove(b)) continue;
    // Kick: a falling sine with a click.
    const i0 = Math.floor(b * RATE);
    for (let k = 0; k < 0.35 * RATE; k++) {
      const t = k / RATE;
      const f = 45 + 110 * Math.exp(-t * 30);
      add(i0 + k, Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 0.5);
    }
    // Clap on two and four, from the iPad on.
    const beatNo = Math.round(b / BEAT) % 4;
    if (b >= 6.5 && (beatNo === 1 || beatNo === 3)) {
      for (let k = 0; k < 0.2 * RATE; k++) {
        const t = k / RATE;
        const n = noise();
        const env = Math.exp(-t * 22) + 0.4 * Math.exp(-((t - 0.012) ** 2) / 0.00002);
        add(i0 + k, n * env * 0.12, noise() * env * 0.12);
      }
    }
  }
  // Hats: offbeat eighths, sixteenths once the computer arrives.
  for (let s = 2.5; s < NAME; s += BEAT / 4) {
    const q = Math.round(s / (BEAT / 4)) % 4;
    if (!groove(s) || (s < 15.5 && q !== 2)) continue;
    const i0 = Math.floor(s * RATE);
    let prev = 0;
    const amp = q === 2 ? 0.06 : 0.025;
    for (let k = 0; k < 0.05 * RATE; k++) {
      const n = noise();
      const v = n - prev; // a rough high-pass
      prev = n;
      add(i0 + k, v * Math.exp((-k / RATE) * 70) * amp * 0.7, v * Math.exp((-k / RATE) * 70) * amp);
    }
  }
  // Bass: the bar's root on every eighth, round and short.
  for (let s = 2.5; s < NAME; s += BEAT / 2) {
    if (!groove(s)) continue;
    const [root] = barAt(s);
    const f = hz(root - 12 + 12);
    const i0 = Math.floor(s * RATE);
    for (let k = 0; k < 0.22 * RATE; k++) {
      const t = k / RATE;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 7);
      add(
        i0 + k,
        (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * env * 0.16,
      );
    }
  }

  // A whoosh into every cut: noise through a sweeping band, rising then gone.
  const whoosh = (at, length, amp) => {
    let b1 = 0;
    let b2 = 0;
    const i0 = Math.floor((at - length) * RATE);
    for (let k = 0; k < (length + 0.15) * RATE; k++) {
      const t = k / RATE;
      const x = Math.min(1, t / length);
      const env = t < length ? x ** 2 : Math.exp(-(t - length) * 30);
      const c = 0.02 + 0.25 * x;
      b1 += c * (noise() - b1);
      b2 += c * (b1 - b2);
      add(i0 + k, (b1 - b2) * env * amp * (1 - x * 0.5), (b1 - b2) * env * amp * (0.5 + x * 0.5));
    }
  };
  for (const c of CUTS) whoosh(c, 0.45, 0.3);
  whoosh(NAME, 0.9, 0.45);
  // The hit for the name: a deep boom and a shimmer.
  {
    const i0 = Math.floor(NAME * RATE);
    for (let k = 0; k < 2.2 * RATE; k++) {
      const t = k / RATE;
      const f = 38 + 60 * Math.exp(-t * 12);
      add(i0 + k, Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 2.5) * 0.55);
      const sh =
        (Math.sin(2 * Math.PI * 2093 * t) + Math.sin(2 * Math.PI * 3136 * t)) *
        Math.exp(-t * 3) *
        0.02;
      add(i0 + k, sh, sh * 0.8);
    }
  }
  // Soft taps where a finger presses in the film.
  for (const at of [7.25, 8.26, 24.55]) {
    const i0 = Math.floor(at * RATE);
    for (let k = 0; k < 0.04 * RATE; k++) {
      const t = k / RATE;
      add(i0 + k, Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 160) * 0.12);
    }
  }

  // Fade the very end, soften the peaks, and scale to just under full.
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const t = i / RATE;
    const fade = t > LENGTH - 0.6 ? (LENGTH - t) / 0.6 : 1;
    L[i] = Math.tanh(L[i] * 1.2) * fade;
    R[i] = Math.tanh(R[i] * 1.2) * fade;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const gain = 0.89 / peak;
  return [L.map((v) => v * gain), R.map((v) => v * gain)];
}

export function writeMusic(path) {
  const [L, R] = makeMusic();
  const data = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    data.writeInt16LE(Math.round(L[i] * 32767), i * 4);
    data.writeInt16LE(Math.round(R[i] * 32767), i * 4 + 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}

if (import.meta.url === `file://${process.argv[1]}`) writeMusic(process.argv[2] ?? 'music.wav');
