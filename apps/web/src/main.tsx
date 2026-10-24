import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ArrivalApp, CrashGuard, AskApp, AskBubbleApp, AskGlowApp, AskPointApp, DropZoneApp, QuickApp, RingApp, SortApp, isArrivalWindow, isAskBubbleWindow, isAskGlowWindow, isAskPointWindow, isAskWindow, isDropZoneWindow, isQuickWindow, isRingWindow, isSortWindow } from '@warraq/ui';
import { registerServiceWorker } from './registerServiceWorker';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// The desktop's quick tools window, its ring (opened from the file manager), a phone's file
// arriving, Ask ZOOD's island, pointer, glow and bubble, and Sort with ZOOD's window and
// drop zone are not the editor.
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
            : isSortWindow()
              ? SortApp
              : isDropZoneWindow()
                ? DropZoneApp
                : App;
createRoot(root).render(
  <StrictMode>
    <CrashGuard>
      <Root />
    </CrashGuard>
  </StrictMode>,
);

registerServiceWorker();
