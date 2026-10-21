// The foldable iPhone, drawn: two halves on a hinge in CSS 3D (css/foldable.css).
// Used by the foldable page (js/foldable.js) and its room on the home page.
const escape = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

// The device: a left and a right half meeting at the hinge. The right half
// carries the outer screen on its back, so folded it lies over the left half
// showing that screen. --fold: 0 open, 1 shut.
export function foldDevice({ inner, outer, label = '' }) {
  return `<div class="fd-device"${label ? ` role="img" aria-label="${escape(label)}"` : ' aria-hidden="true"'}>
    <div class="fd-body">
      <div class="fd-half fd-left"><div class="fd-face"><div class="fd-screen fd-inner-l">${inner}</div></div><div class="fd-back"></div></div>
      <div class="fd-half fd-right">
        <div class="fd-face"><div class="fd-screen fd-inner-r">${inner}</div><span class="fd-crease"></span></div>
        <div class="fd-face fd-cover"><div class="fd-screen">${outer}<span class="fd-island"></span></div></div>
      </div>
    </div>
    <div class="fd-ground"></div>
  </div>`;
}

// --fold: 0 open, 1 shut; the turn and tilt face it away from you.
export const setFold = (el, fold, turn = 0, tilt = 0) => {
  el.style.setProperty('--fold', fold.toFixed(4));
  el.style.setProperty('--turn', `${turn.toFixed(2)}deg`);
  el.style.setProperty('--tilt', `${tilt.toFixed(2)}deg`);
};
