import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, QuickApp, RingApp, isQuickWindow, isRingWindow } from '@warraq/ui';
import { registerServiceWorker } from './registerServiceWorker';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// The desktop's quick tools window and its ring (opened from the file manager) are not the editor.
const Root = isRingWindow() ? RingApp : isQuickWindow() ? QuickApp : App;
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

registerServiceWorker();
