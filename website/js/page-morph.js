// The phone that carries across pages. The home page's foldable section and
// the iPhone Duo page's hero phone take one view-transition name for the
// moment one page hands over to the other, so the browser moves the phone
// from one page to the next (the @view-transition rule is in css/site.css and
// is off with Reduce Motion). Browsers without cross-page view transitions
// simply load the page. The pages' referrer policy is same-origin (not
// no-referrer) because the browser hides the other page's address from these
// events under no-referrer; nothing is sent to other sites either way.
const NAME = 'duo-phone';

const phone = () => document.querySelector('.fold-room .fd-device, .fd-hero .fd-device');

function onScreen(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
}

const path = (url) => new URL(url, location.href).pathname;

// Is `url` the other page of the pair: the Duo page from the home page, or
// the home page (same language) from the Duo page?
function pairs(url) {
  if (!url) return false;
  const here = document.documentElement.dataset.page;
  if (here === 'story') return /\/iphone-duo\/(index\.html)?$/.test(path(url));
  if (here === 'iphone-duo') return path(url).replace(/index\.html$/, '') === path('../');
  return false;
}

function name(event, url) {
  const el = phone();
  if (!el) return;
  el.style.removeProperty('view-transition-name');
  if (!event.viewTransition || !onScreen(el) || !pairs(url)) return;
  el.style.viewTransitionName = NAME;
  event.viewTransition.finished.finally(() => el.style.removeProperty('view-transition-name'));
}

export function startPageMorph() {
  addEventListener('pageswap', (e) => name(e, e.activation?.entry?.url));
  addEventListener('pagereveal', (e) => name(e, globalThis.navigation?.activation?.from?.url));
}
