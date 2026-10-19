import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, QuickApp, isQuickWindow } from '@warraq/ui';
import { registerServiceWorker } from './registerServiceWorker';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// The desktop's quick tools window (opened from the file manager) is not the editor.
createRoot(root).render(<StrictMode>{isQuickWindow() ? <QuickApp /> : <App />}</StrictMode>);

registerServiceWorker();
