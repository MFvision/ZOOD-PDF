// Month lengths of the Umm al-Qura calendar, 1356–1500 AH, from ICU (via
// Intl), for warraq-pdf/src/forms/hijri.rs, and a sample of dates to test it
// against: node tests/fixtures/forms/umalqura.mjs
const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
const parts = (d) => Object.fromEntries(f.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
let t = Date.UTC(1937, 2, 14);
const starts = [];
for (let i = 0; i < 60000; i++, t += 86400000) {
  const p = parts(new Date(t));
  if (p.day === 1) starts.push({ y: p.year, m: p.month, t });
  if (p.year === 1501) break;
}
const years = [];
for (let y = 1356; y <= 1500; y++) {
  let mask = 0;
  for (let m = 1; m <= 12; m++) {
    const a = starts.find((s) => s.y === y && s.m === m);
    const b = starts.find((s) => (m === 12 ? s.y === y + 1 && s.m === 1 : s.y === y && s.m === m + 1));
    const len = (b.t - a.t) / 86400000;
    if (len !== 29 && len !== 30) throw new Error(`bad ${y}/${m}: ${len}`);
    if (len === 30) mask |= 1 << (m - 1);
  }
  years.push(mask);
}
const first = starts.find((s) => s.y === 1356 && s.m === 1);
console.log(JSON.stringify({ firstDay: first.t / 86400000, years: years.map((m) => m.toString(16).padStart(3, '0')).join('') }));
// A sample to test against: every 97th day from 1937 to 2077.
const sample = [];
for (let d = first.t / 86400000; d < first.t / 86400000 + 51000; d += 97) {
  const p = parts(new Date(d * 86400000));
  if (p.year > 1500) break;
  sample.push([d, p.year, p.month, p.day]);
}
console.log(JSON.stringify(sample.slice(0, 5)), sample.length);
import('node:fs').then((fs) => fs.writeFileSync(new URL('./umalqura-icu-sample.json', import.meta.url), JSON.stringify(sample)));
