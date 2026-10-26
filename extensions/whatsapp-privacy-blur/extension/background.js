/* global chrome, importScripts */
// The only job of the background worker: the keyboard shortcut (Alt+Shift+B by default).
// Chrome hands the shortcut to the extension directly, so nothing listens to keys on the page.
importScripts('defaults.js');

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-blur') return;
  const { enabled } = await chrome.storage.local.get({ enabled: globalThis.WPB_DEFAULTS.enabled });
  await chrome.storage.local.set({ enabled: !enabled });
});
