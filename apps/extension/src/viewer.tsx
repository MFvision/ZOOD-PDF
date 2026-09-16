// Extension viewer page: mounts the shared Warraq UI. The host adds nothing but
// the mount point and the localized tab title; file access in Phase 1 goes
// through the UI's own file picker (no host permissions, no file:// access yet).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@warraq/ui';

if (typeof chrome !== 'undefined' && chrome.i18n) {
  document.title = chrome.i18n.getMessage('viewerTitle') || 'Warraq';
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('viewer.html has no #root element');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
