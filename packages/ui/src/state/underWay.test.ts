import { describe, expect, it } from 'vitest';
import { changesUnderWay } from './underWay';

describe('changes under way', () => {
  it('lets a save wait for an edit still finding its font', async () => {
    const changes = changesUnderWay();
    let file = 'before';
    let finish = () => {};
    void changes.track(new Promise<void>((resolve) => (finish = () => ((file = 'after'), resolve()))));
    const saved = changes.settled().then(() => file);
    finish();
    expect(await saved).toBe('after');
  });

  it('does not hold a save on a change that failed, or after the changes are done', async () => {
    const changes = changesUnderWay();
    await changes.track(Promise.reject(new Error('E_EDIT'))).catch(() => undefined);
    await changes.track(Promise.resolve(1));
    await expect(changes.settled()).resolves.toBeUndefined();
  });
});
