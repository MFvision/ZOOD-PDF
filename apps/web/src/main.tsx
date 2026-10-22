import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ArrivalApp, AskApp, AskBubbleApp, AskGlowApp, AskPointApp, QuickApp, RingApp, isArrivalWindow, isAskBubbleWindow, isAskGlowWindow, isAskPointWindow, isAskWindow, isQuickWindow, isRingWindow } from '@warraq/ui';
import { registerServiceWorker } from './registerServiceWorker';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// The desktop's quick tools window, its ring (opened from the file manager), a phone's file
// arriving and Ask ZOOD's island, pointer, glow and bubble are not the editor.
const Root = isAskWindow()
  ? AskApp
  : isAskPointWindow()
    ? AskPointApp
    : isAskGlowWindow()
      ? AskGlowApp
      : isAskBubbleWindow()
        ? AskBubbleApp
      : isArrivalWindow()
        ? ArrivalApp
        : isRingWindow()
          ? RingApp
          : isQuickWindow()
            ? QuickApp
            : App;
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

registerServiceWorker();
