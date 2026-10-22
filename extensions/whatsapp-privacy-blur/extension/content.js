/* global chrome */
// Page script for https://web.whatsapp.com only.
//
// It never reads the page. All it does is:
//   1. set a few data-* attributes and one CSS variable on <html> (content.css does the blurring);
//   2. draw its own floating toolbar inside a closed shadow root.
// No network, no messaging, no keyboard listeners, no access to chats, contacts or media.
(() => {
  'use strict';

  const D = globalThis.WPB_DEFAULTS;
  const MODES = globalThis.WPB_MODES;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const html = document.documentElement;
  const t = (key) => chrome.i18n.getMessage(key) || key;

  let state = { ...D };
  let bar = null;

  function clean(s) {
    return {
      ...s,
      mode: MODES.includes(s.mode) ? s.mode : D.mode,
      amount: Math.min(20, Math.max(1, Math.round(Number(s.amount) || D.amount))),
    };
  }

  function persist(patch) {
    try {
      chrome.storage.local.set(patch).catch(() => {});
    } catch {
      // The extension was reloaded or removed; this page copy of the script is orphaned.
    }
  }

  function applyToPage() {
    html.toggleAttribute('data-wpb-off', !state.enabled);
    html.setAttribute('data-wpb-mode', state.mode);
    html.toggleAttribute('data-wpb-nopeek', !state.peek);
    html.toggleAttribute('data-wpb-instant', !state.smooth);
    html.style.setProperty('--wpb-blur', `${state.amount}px`);
  }

  function update(patch, save) {
    state = clean({ ...state, ...patch });
    applyToPage();
    if (state.toolbar && document.body) {
      bar ??= createToolbar();
      bar.render();
    } else if (bar) {
      bar.remove();
      bar = null;
    }
    if (save) persist(patch);
  }

  // ---- icons (24x24, drawn here, no external files) ----

  const ICONS = {
    move: ['M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3'],
    eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
    eyeOff: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M4 4l16 16'],
    contacts: ['M3 5h18v14H3z', { fill: 'M3 5h6v14H3z' }],
    chat: ['M3 5h18v14H3z', { fill: 'M9 5h12v14H9z' }],
    both: ['M3 5h18v14H3z', { fill: 'M3 5h18v14H3z' }],
    settings: ['M4 7h9M17 7h3M4 17h3M11 17h9', 'M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0', 'M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0'],
    collapse: ['M11 17l-5-5 5-5M18 17l-5-5 5-5'],
    expand: ['M13 17l5-5-5-5M6 17l5-5-5-5'],
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const part of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', typeof part === 'string' ? part : part.fill);
      if (typeof part !== 'string') path.setAttribute('class', 'fill');
      svg.append(path);
    }
    return svg;
  }

  function setIcon(button, name) {
    button.replaceChildren(icon(name));
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  // ---- floating toolbar ----

  const TOOLBAR_CSS = `
    :host { all: initial; direction: ltr; position: fixed; z-index: 2147483647; top: 12px; right: 140px;
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e9edef; }
    .bar { display: flex; align-items: center; gap: 6px; padding: 5px 7px; position: relative;
      background: rgba(17, 27, 33, 0.94); border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); user-select: none; }
    button { all: unset; box-sizing: border-box; width: 32px; height: 32px; border-radius: 50%;
      display: grid; place-items: center; background: #3b4a54; color: #e9edef; cursor: pointer; }
    button:hover { background: #4b5d69; }
    button:focus-visible { outline: 2px solid #25d366; outline-offset: 2px; }
    button.on { background: #25d366; color: #0b141a; }
    button.on:hover { background: #2fe072; }
    .grip { background: transparent; width: 24px; cursor: grab; touch-action: none; }
    .grip:hover { background: transparent; }
    .grip:active { cursor: grabbing; }
    svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2;
      stroke-linecap: round; stroke-linejoin: round; }
    path.fill { fill: currentColor; stroke: none; opacity: 0.85; }
    .range { display: flex; align-items: center; gap: 6px; padding-inline: 2px; }
    input[type="range"] { width: 84px; margin: 0; accent-color: #25d366; cursor: pointer; }
    .val { min-width: 18px; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
    .sep { width: 1px; height: 20px; background: rgba(255, 255, 255, 0.18); }
    .menu { position: absolute; top: calc(100% + 8px); right: 0; min-width: 220px; padding: 8px;
      display: grid; gap: 4px; background: rgba(17, 27, 33, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4); }
    .menu[hidden] { display: none; }
    .menu label { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 6px 8px; border-radius: 8px; cursor: pointer; }
    .menu label:hover { background: rgba(255, 255, 255, 0.06); }
    .menu input { accent-color: #25d366; width: 16px; height: 16px; margin: 0; cursor: pointer; }
    .menu .text { all: unset; padding: 6px 8px; border-radius: 8px; width: auto; height: auto;
      display: block; background: transparent; color: #8696a0; cursor: pointer; }
    .menu .text:hover { background: rgba(255, 255, 255, 0.06); color: #e9edef; }
    .collapsed .full { display: none; }
  `;

  function createToolbar() {
    const host = document.createElement('wpb-toolbar');
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(TOOLBAR_CSS);
    shadow.adoptedStyleSheets = [sheet];

    const grip = el('button', { className: 'grip', title: t('moveToolbar') });
    setIcon(grip, 'move');
    const slider = el('input', { type: 'range', min: 1, max: 20, step: 1, title: t('strength') });
    const value = el('span', { className: 'val' });
    const range = el('div', { className: 'range full' }, [slider, value]);
    const sep = el('span', { className: 'sep full' });
    const eye = el('button');
    const mode = el('button', { className: 'full' });
    const gear = el('button', { className: 'full', title: t('settings') });
    setIcon(gear, 'settings');
    const fold = el('button');

    const peek = el('input', { type: 'checkbox' });
    const smooth = el('input', { type: 'checkbox' });
    const hide = el('button', { className: 'text', textContent: t('hideToolbar') });
    const menu = el('div', { className: 'menu', hidden: true, dir: t('@@bidi_dir') }, [
      el('label', {}, [el('span', { textContent: t('hoverPeek') }), peek]),
      el('label', {}, [el('span', { textContent: t('smooth') }), smooth]),
      hide,
    ]);

    const wrap = el('div', { className: 'bar' }, [grip, range, sep, eye, mode, gear, fold, menu]);
    shadow.append(wrap);
    html.append(host);

    slider.addEventListener('input', () => {
      value.textContent = slider.value;
      update({ amount: Number(slider.value) }, false);
    });
    slider.addEventListener('change', () => update({ amount: Number(slider.value) }, true));
    eye.addEventListener('click', () => update({ enabled: !state.enabled }, true));
    mode.addEventListener('click', () => {
      update({ mode: MODES[(MODES.indexOf(state.mode) + 1) % MODES.length] }, true);
    });
    gear.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
    });
    fold.addEventListener('click', () => {
      menu.hidden = true;
      update({ collapsed: !state.collapsed }, true);
    });
    peek.addEventListener('change', () => update({ peek: peek.checked }, true));
    smooth.addEventListener('change', () => update({ smooth: smooth.checked }, true));
    hide.addEventListener('click', () => update({ toolbar: false }, true));

    // Drag by the grip. Pointer capture keeps the events on our own button.
    function place(x, y) {
      const r = host.getBoundingClientRect();
      host.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width))}px`;
      host.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height))}px`;
      host.style.right = 'auto';
    }
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const start = host.getBoundingClientRect();
      const dx = e.clientX - start.left;
      const dy = e.clientY - start.top;
      const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
      const done = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', done);
        grip.removeEventListener('pointercancel', done);
        const end = host.getBoundingClientRect();
        update({ pos: { x: Math.round(end.left), y: Math.round(end.top) } }, true);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', done);
      grip.addEventListener('pointercancel', done);
    });
    const onResize = () => {
      if (state.pos) place(state.pos.x, state.pos.y);
    };
    addEventListener('resize', onResize);

    return {
      render() {
        wrap.classList.toggle('collapsed', state.collapsed);
        if (shadow.activeElement !== slider) slider.value = String(state.amount);
        value.textContent = String(state.amount);
        eye.classList.toggle('on', state.enabled);
        setIcon(eye, state.enabled ? 'eyeOff' : 'eye');
        eye.title = state.enabled ? t('blurOn') : t('blurOff');
        setIcon(mode, state.mode);
        mode.title = `${t('whatToBlur')}: ${t(`mode_${state.mode}`)}`;
        setIcon(fold, state.collapsed ? 'expand' : 'collapse');
        fold.title = state.collapsed ? t('expand') : t('collapse');
        peek.checked = state.peek;
        smooth.checked = state.smooth;
        if (state.pos) {
          place(state.pos.x, state.pos.y);
        } else {
          host.style.removeProperty('left');
          host.style.removeProperty('top');
          host.style.removeProperty('right');
        }
      },
      remove() {
        removeEventListener('resize', onResize);
        host.remove();
      },
    };
  }

  // ---- start ----

  applyToPage();
  chrome.storage.local.get(D).then((saved) => update(saved, false));
  // The script starts before <body> exists; the toolbar waits for it.
  document.addEventListener('DOMContentLoaded', () => update({}, false), { once: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in D) patch[key] = newValue === undefined ? D[key] : newValue;
    }
    update(patch, false);
  });
})();
