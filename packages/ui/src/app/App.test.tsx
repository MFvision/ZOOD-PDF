import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { AppProvider } from '../services/AppContext';
import { App } from './App';
import { AiCard } from './Home';
import { createRecentsStore } from '../services/recents';
import { setAiHandler } from '../services/ai';
import type { HostBridge } from '../services/host';

function fakeHost(): HostBridge {
  return {
    kind: 'web',
    openFiles: vi.fn(async () => []),
    saveFile: vi.fn(async (name: string) => ({ name })),
    onHostDrop: () => () => {},
  };
}

function renderApp(locale: 'en' | 'ar' = 'en') {
  const host = fakeHost();
  const recents = createRecentsStore({ idb: new IDBFactory() });
  render(
    <AppProvider host={host} recents={recents} initialLocale={locale}>
      <App />
    </AppProvider>,
  );
  return { host, recents };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('<App> home', () => {
  it('shows the hero, six working action cards and only ready tools', () => {
    renderApp('en');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PDF, reimagined');
    const cards = document.querySelectorAll('.action-card');
    expect(cards).toHaveLength(6);
    const tools = [...document.querySelectorAll('[data-testid=sidebar-tools] [data-tool]')].map((b) => b.getAttribute('data-tool'));
    expect(tools.sort()).toEqual(['comment', 'fill-sign', 'prepare-form', 'protect', 'redact']);
    // AI is not ready: no AI card, no AI action card
    expect(document.querySelector('.ai-card')).toBeNull();
    expect(document.querySelector('[data-card=ai]')).toBeNull();
  });

  it('sets <html lang dir> and the title from the locale', () => {
    renderApp('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.title).toBe('زود PDF');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ملفات PDF، من جديد');
  });

  it('the Open card asks the host for files', async () => {
    const { host } = renderApp();
    fireEvent.click(document.querySelector('[data-card=open]')!);
    await waitFor(() => expect(host.openFiles).toHaveBeenCalled());
  });

  it('the + menu offers Open, and no Install item before beforeinstallprompt', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open PDF…' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Install app' })).toBeNull();
  });

  it('opens the ⌘K search with the keyboard', () => {
    renderApp();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('combobox', { name: 'Search' })).toBeTruthy();
  });
});

describe('<AiCard>', () => {
  it('chips put a real prompt in the box; nothing is sent until Send', () => {
    const handler = vi.fn();
    setAiHandler(handler);
    render(
      <AppProvider host={fakeHost()} recents={createRecentsStore({ idb: new IDBFactory() })} initialLocale="en">
        <AiCard />
      </AppProvider>,
    );
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.value).toBe('Summarize this document in a short paragraph.');
    expect(handler).not.toHaveBeenCalled();
    fireEvent.click(send);
    expect(handler).toHaveBeenCalledWith('Summarize this document in a short paragraph.', expect.any(Object));
    setAiHandler(null);
  });
});
