import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRecent, forgetRecentThumbnail, readRecentThumbnails, saveRecentThumbnail } from '../state/recent';
import { THUMB_BOX, thumbnailScale } from './recentPicture';

describe('the recent grid’s picture of a first page', () => {
  it('is drawn to fit its box whatever the page’s shape', () => {
    for (const [width, height] of [
      [595, 842],
      [842, 595],
      [100, 4000],
      [4000, 100],
      [12, 12],
    ] as const) {
      const scale = thumbnailScale(width, height);
      expect(scale, `${width}×${height}`).not.toBeNull();
      const drawn = Math.min(scale!, 8);
      expect(width * drawn).toBeLessThanOrEqual(THUMB_BOX.width);
      expect(height * drawn).toBeLessThanOrEqual(THUMB_BOX.height);
    }
  });

  it('is not drawn at all for a page the core would draw larger than its box', () => {
    // The page's size is read from the file: a hostile one claims a million
    // points, and the core never draws below 0.05×.
    expect(thumbnailScale(1_400_000, 1_400_000)).toBeNull();
    expect(thumbnailScale(100, 100_000)).toBeNull();
    expect(thumbnailScale(0, 842)).toBeNull();
    expect(thumbnailScale(Number.NaN, 842)).toBeNull();
    expect(thumbnailScale(Number.POSITIVE_INFINITY, 842)).toBeNull();
  });
});

describe('the pictures kept for the recent grid', () => {
  const picture = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('forgets one file’s picture and keeps the others', () => {
    addRecent('a.pdf');
    addRecent('b.pdf');
    saveRecentThumbnail('a.pdf', picture);
    saveRecentThumbnail('b.pdf', picture);
    forgetRecentThumbnail('a.pdf');
    expect(readRecentThumbnails()).toEqual({ 'b.pdf': picture });
  });
});
