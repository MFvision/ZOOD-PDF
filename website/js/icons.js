// Small line icons for the promises (hero facts, privacy points). Drawn on a
// 20-unit grid in the stroke style of the theme switch (main.js), so they read
// as one set. Each is decorative: the words beside it carry the meaning.
const svg = (body) =>
  `<svg class="promise-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// The slash every "no …" icon shares.
const slash = '<path d="M3 3l14 14"/>';

export const ICONS = {
  // A price tag with nothing on it.
  free: svg(
    '<path d="M10.6 2.8H16a1.2 1.2 0 0 1 1.2 1.2v5.4l-7.6 7.6a1.4 1.4 0 0 1-2 0L3 12.4a1.4 1.4 0 0 1 0-2Z"/><circle cx="13.6" cy="6.4" r="1.2"/>',
  ),
  // A person, crossed out.
  account: svg(
    `<circle cx="10" cy="6.6" r="3"/><path d="M4 17c.6-3.2 3-5 6-5s5.4 1.8 6 5"/>${slash}`,
  ),
  // A loudspeaker, crossed out.
  ads: svg(
    `<path d="M3.5 8.2v3.6h3l5.5 3.7V4.5L6.5 8.2Z"/><path d="M15 7.5a3.5 3.5 0 0 1 0 5"/>${slash}`,
  ),
  // Wi-Fi, crossed out.
  offline: svg(
    `<path d="M2.5 7.6a11 11 0 0 1 15 0M5 10.6a7.2 7.2 0 0 1 10 0M7.6 13.5a3.4 3.4 0 0 1 4.8 0"/><circle cx="10" cy="16.2" r=".6" fill="currentColor"/>${slash}`,
  ),
  // A chip with a spark: the AI that runs on this computer.
  ai: svg(
    '<rect x="5" y="5" width="10" height="10" rx="2"/><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5"/><path d="M10 7.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7Z"/>',
  ),
  // A laptop.
  computer: svg('<rect x="4" y="4" width="12" height="8.5" rx="1.2"/><path d="M2 16h16"/>'),
  // A padlock: files stay on the device.
  device: svg(
    '<rect x="4.5" y="9" width="11" height="8" rx="1.6"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
  ),
  // An eye, crossed out: nothing is watched or counted.
  telemetry: svg(
    `<path d="M2 10s3-5.2 8-5.2S18 10 18 10s-3 5.2-8 5.2S2 10 2 10Z"/><circle cx="10" cy="10" r="2.4"/>${slash}`,
  ),
};
