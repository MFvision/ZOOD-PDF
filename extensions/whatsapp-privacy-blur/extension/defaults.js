// Default settings, shared by the page script, the popup and the background worker.
// Settings live in chrome.storage.local, which stays on this computer (it is not synced).
globalThis.WPB_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'both', // 'contacts' | 'chat' | 'both'
  amount: 6, // blur radius in px, 1-20
  peek: true, // hover over a blurred area to read it
  peekOne: true, // hover reveals only the chat or message under the mouse, not the whole area
  smooth: true, // fade in and out instead of an instant reveal
  toolbar: true, // floating toolbar on the WhatsApp page
  collapsed: false,
  pos: null, // toolbar position { x, y } in px; null keeps the default corner
});

globalThis.WPB_MODES = Object.freeze(['contacts', 'chat', 'both']);
