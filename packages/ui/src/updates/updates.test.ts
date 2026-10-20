import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSettings } from '../state/settings';
import {
  checkForUpdate,
  dismissUpdate,
  getUpdateState,
  installUpdate,
  resetUpdateState,
  scheduleStartupCheck,
} from './updates';

type Host = {
  invoke: ReturnType<typeof vi.fn>;
  transformCallback: () => number;
  metadata: { currentWindow: { label: string } };
};

function fakeHost(answers: Record<string, unknown>, label = 'main'): Host {
  const host: Host = {
    invoke: vi.fn(async (cmd: string) => {
      const answer = answers[cmd];
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    transformCallback: () => 1,
    metadata: { currentWindow: { label } },
  };
  (globalThis as { __TAURI_INTERNALS__?: Host }).__TAURI_INTERNALS__ = host;
  return host;
}

describe('updates', () => {
  beforeEach(() => resetUpdateState());
  afterEach(() => {
    delete (globalThis as { __TAURI_INTERNALS__?: Host }).__TAURI_INTERNALS__;
    updateSettings({ checkUpdates: true });
    vi.useRealTimers();
  });

  it('does nothing in a browser', async () => {
    expect(await checkForUpdate()).toBeNull();
    expect(getUpdateState().phase).toBe('idle');
  });

  it('shows the version the channel offers', async () => {
    fakeHost({ update_check: { version: '0.2.0', currentVersion: '0.1.0', notes: ' Faster ' } });
    expect(await checkForUpdate()).toEqual({
      version: '0.2.0',
      currentVersion: '0.1.0',
      notes: 'Faster',
    });
    expect(getUpdateState().phase).toBe('available');
  });

  it('says when this is the latest, and when the check failed', async () => {
    fakeHost({ update_check: null });
    await checkForUpdate();
    expect(getUpdateState().phase).toBe('latest');
    fakeHost({ update_check: new Error('E_UPDATE: offline') });
    await checkForUpdate();
    expect(getUpdateState().phase).toBe('failed');
  });

  it('installs only after a check found something', async () => {
    const host = fakeHost({
      update_check: { version: '0.2.0', currentVersion: '0.1.0' },
      update_install: undefined,
    });
    await installUpdate();
    expect(host.invoke).not.toHaveBeenCalledWith('update_install', undefined, undefined);
    await checkForUpdate();
    dismissUpdate();
    expect(getUpdateState().dismissed).toBe(true);
    await installUpdate();
    expect(host.invoke).toHaveBeenCalledWith('update_install', undefined, undefined);
  });

  it('checks at launch in the main window only, and only when left on', async () => {
    vi.useFakeTimers();
    const host = fakeHost({ update_check: null }, 'doc-2');
    scheduleStartupCheck(10);
    await vi.advanceTimersByTimeAsync(20);
    expect(host.invoke).not.toHaveBeenCalled();

    resetUpdateState();
    const main = fakeHost({ update_check: null });
    updateSettings({ checkUpdates: false });
    scheduleStartupCheck(10);
    await vi.advanceTimersByTimeAsync(20);
    expect(main.invoke).not.toHaveBeenCalled();

    resetUpdateState();
    updateSettings({ checkUpdates: true });
    scheduleStartupCheck(10);
    await vi.advanceTimersByTimeAsync(20);
    expect(main.invoke).toHaveBeenCalledWith('update_check', undefined, undefined);
  });
});
