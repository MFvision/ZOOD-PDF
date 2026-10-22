// The home page's foldable room: the drawn foldable iPhone (fold-device.js)
// turns toward you and opens as the room scrolls past, and the words link to
// the full page (iphone-duo/). With Reduce Motion it waits open.
import { foldDevice, setFold } from './fold-device.js';
import { ease, span } from './motion.js';

export function foldScene(media) {
  const img = (device, name) =>
    `<img class="fd-shot" alt="" decoding="async" data-screen="${device} ${name}" src="${media.still(device, name)}">`;
  return `<div class="fold-room">${foldDevice({ inner: img('tablet', 'comment'), outer: img('phone', 'home') })}</div>`;
}

export function foldFrame(el, p, reduced) {
  const device = el.querySelector('.fd-device');
  if (!device) return;
  if (reduced) {
    setFold(device, 0);
    return;
  }
  const face = ease(span(p, 0.05, 0.4));
  const open = ease(span(p, 0.3, 0.7));
  setFold(device, 1 - open, (1 - face) * -30, (1 - face) * 8);
}
