import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ArrivalApp, QuickApp, RingApp, isArrivalWindow, isQuickWindow, isRingWindow } from '@warraq/ui';
import { registerServiceWorker } from './registerServiceWorker';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// The desktop's quick tools window, its ring (opened from the file manager) and a phone's file
// arriving are not the editor.
const Root = isArrivalWindow() ? ArrivalApp : isRingWindow() ? RingApp : isQuickWindow() ? QuickApp : App;
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

registerServiceWorker();
