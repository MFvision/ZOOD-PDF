/* global chrome */
// Warraq extension service worker (Manifest V3; one build for Chrome, Edge, Brave).
//
// Phase 1: the context-menu item "Open with Warraq" and the toolbar button open
// the viewer page (viewer.html, which mounts @warraq/ui). PDF navigation
// interception and file:// access come in Phase 7 (see README.md); the URL the
// user right-clicked is passed along as ?src= so that phase has it, but Phase 1
// does not fetch it (there are no host permissions).

const MENU_ID = 'warraq-open';

function viewerUrl(src) {
  const url = new URL(chrome.runtime.getURL('viewer.html'));
  if (src) url.searchParams.set('src', src);
  return url.toString();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: chrome.i18n.getMessage('contextMenuOpen'),
      contexts: ['page', 'link', 'action'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  chrome.tabs.create({ url: viewerUrl(info.linkUrl || info.pageUrl) });
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: viewerUrl() });
});
