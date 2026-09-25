/// <reference types="chrome" />
// Clicking the toolbar button opens the app page in a tab (no permissions needed).
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
