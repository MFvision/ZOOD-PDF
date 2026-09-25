/**
 * @zood/ui public entry. Hosts call `mountApp` (web, extension, desktop). The HostBridge interface is
 * exported so native hosts can install their own implementation as `window.__ZOOD_HOST__`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppProvider } from './services/AppContext';
import { captureInstallPrompt } from './services/install';
import type { Platform } from './tools/registry';
import './styles/index.css';

export type { HostBridge, OpenedFile, SaveOptions, SaveResult, DropPoint } from './services/host';
export { getHost, setHost } from './services/host';
export { webHost } from './services/files';
export { engine, createEngineClient, EngineError } from './services/engine';
export type { EngineClient, Reply } from './services/engine';
export { TOOLS, readyTools, isToolReady } from './tools/registry';
export type { ToolDef, ToolId, Platform } from './tools/registry';
export { setAiHandler, setCloudOpener } from './services/ai';
export { APP_MARK_SVG } from './app/AppMark';

export interface MountOptions {
  platform?: Platform;
}

export function mountApp(el: HTMLElement, opts: MountOptions = {}): () => void {
  captureInstallPrompt();
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <AppProvider platform={opts.platform ?? 'web'}>
        <App />
      </AppProvider>
    </StrictMode>,
  );
  return () => root.unmount();
}
