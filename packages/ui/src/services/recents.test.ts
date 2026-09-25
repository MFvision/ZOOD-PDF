import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createRecentsStore, searchRecents, normalizeForSearch, type RecentItem } from './recents';

const pdf = (n: number) => new TextEncoder().encode(`%PDF-1.7 fixture ${n}`);

describe('recents store (IndexedDB)', () => {
  let store: ReturnType<typeof createRecentsStore>;
  let now = 1000;
  beforeEach(() => {
    now = 1000;
    store = createRecentsStore({ idb: new IDBFactory(), maxBytes: 64, now: () => now++ });
  });

  it('adds a file and lists newest first', async () => {
    const a = await store.add({ name: 'a.pdf', bytes: pdf(1) });
    const b = await store.add({ name: 'b.pdf', bytes: pdf(2) });
    const list = await store.list();
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ name: 'b.pdf', size: pdf(2).byteLength, starred: false, tags: [] });
  });

  it('re-opening the same bytes updates the entry instead of duplicating', async () => {
    const a = await store.add({ name: 'a.pdf', bytes: pdf(1) });
    const again = await store.add({ name: 'a.pdf', bytes: pdf(1) });
    expect(again.id).toBe(a.id);
    expect(await store.list()).toHaveLength(1);
    expect(again.openedAt).toBeGreaterThan(a.openedAt);
  });

  it('keeps bytes only under the size cap', async () => {
    const small = await store.add({ name: 's.pdf', bytes: pdf(1) });
    const big = await store.add({ name: 'b.pdf', bytes: new Uint8Array(100) });
    expect(Array.from((await store.getBytes(small.id))!)).toEqual(Array.from(pdf(1)));
    expect(await store.getBytes(big.id)).toBeUndefined();
    expect((await store.list()).find((r) => r.id === big.id)?.hasBytes).toBe(false);
  });

  it('stores, and forgets, first-page thumbnails (dropped after redaction/protection)', async () => {
    const a = await store.add({ name: 'a.pdf', bytes: pdf(1) });
    await store.setThumbnail(a.id, new Uint8Array([137, 80, 78, 71]));
    expect(Array.from((await store.list())[0]!.thumbnail!)).toEqual([137, 80, 78, 71]);
    await store.forgetThumbnail(a.id);
    const after = (await store.list())[0];
    expect(after?.thumbnail).toBeUndefined();
    expect(after?.hasBytes).toBe(false);
    expect(await store.getBytes(a.id)).toBeUndefined();
  });

  it('stars, tags and removes items', async () => {
    const a = await store.add({ name: 'a.pdf', bytes: pdf(1) });
    await store.update(a.id, { starred: true, tags: ['work', 'عقود'] });
    expect((await store.list())[0]).toMatchObject({ starred: true, tags: ['work', 'عقود'] });
    await store.remove(a.id);
    expect(await store.list()).toEqual([]);
    expect(await store.getBytes(a.id)).toBeUndefined();
  });
});

describe('search', () => {
  const item = (name: string, tags: string[] = []): RecentItem => ({
    id: name,
    name,
    size: 1,
    openedAt: 1,
    starred: false,
    tags,
    hasBytes: false,
  });

  it('normalises Arabic: tashkeel, tatweel, alef/yaa/taa-marbuta forms and digits', () => {
    expect(normalizeForSearch('العَقْـــد')).toBe(normalizeForSearch('العقد'));
    expect(normalizeForSearch('إقرار')).toBe(normalizeForSearch('اقرار'));
    expect(normalizeForSearch('فاتورة')).toBe(normalizeForSearch('فاتوره'));
    expect(normalizeForSearch('مستوى')).toBe(normalizeForSearch('مستوي'));
    expect(normalizeForSearch('٢٠٢٦')).toBe('2026');
  });

  it('matches names and tags, case-insensitively', () => {
    const items = [item('Invoice 2026.pdf'), item('عقد الإيجار.pdf', ['سكن']), item('notes.pdf', ['Work'])];
    expect(searchRecents(items, 'invoice').map((i) => i.name)).toEqual(['Invoice 2026.pdf']);
    expect(searchRecents(items, 'الايجار').map((i) => i.name)).toEqual(['عقد الإيجار.pdf']);
    expect(searchRecents(items, '٢٠٢٦').map((i) => i.name)).toEqual(['Invoice 2026.pdf']);
    expect(searchRecents(items, 'work').map((i) => i.name)).toEqual(['notes.pdf']);
    expect(searchRecents(items, '   ')).toEqual([]);
  });
});
