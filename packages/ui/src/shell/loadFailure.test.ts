import { afterEach, describe, expect, it } from 'vitest';
import { loadFailed, resetLoadFailure, watchLoadFailures } from './loadFailure';

describe('a part of the app that could not be fetched', () => {
  afterEach(() => resetLoadFailure());

  it('is noticed from the event Vite fires for it', () => {
    const target = new EventTarget();
    watchLoadFailures(target);
    expect(loadFailed()).toBe(false);
    target.dispatchEvent(new Event('vite:preloadError'));
    expect(loadFailed()).toBe(true);
  });

  it('is not noticed from other events', () => {
    const target = new EventTarget();
    watchLoadFailures(target);
    target.dispatchEvent(new Event('error'));
    expect(loadFailed()).toBe(false);
  });
});
