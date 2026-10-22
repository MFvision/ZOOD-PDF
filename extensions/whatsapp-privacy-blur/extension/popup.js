/* global chrome */
// The toolbar-button popup. It only reads and writes this extension's own settings.
(async () => {
  'use strict';

  const D = globalThis.WPB_DEFAULTS;
  const $ = (id) => document.getElementById(id);
  const t = (key) => chrome.i18n.getMessage(key) || key;

  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.documentElement.dir = chrome.i18n.getMessage('@@bidi_dir') || 'ltr';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);

  const save = (patch) => chrome.storage.local.set(patch);
  const s = await chrome.storage.local.get(D);

  const enabled = $('enabled');
  enabled.checked = s.enabled;
  enabled.addEventListener('change', () => save({ enabled: enabled.checked }));

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === s.mode;
    radio.addEventListener('change', () => save({ mode: radio.value }));
  }

  const amount = $('amount');
  const amountOut = $('amountOut');
  amount.value = String(s.amount);
  amountOut.textContent = String(s.amount);
  amount.addEventListener('input', () => {
    amountOut.textContent = amount.value;
    save({ amount: Number(amount.value) });
  });

  for (const key of ['peek', 'peekOne', 'smooth', 'toolbar']) {
    const box = $(key);
    box.checked = s[key];
    box.addEventListener('change', () => save({ [key]: box.checked }));
  }

  $('resetPos').addEventListener('click', () => save({ pos: null, collapsed: false, toolbar: true }));

  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === 'toggle-blur');
  $('shortcut').textContent = toggle?.shortcut || t('shortcutNotSet');
})();
