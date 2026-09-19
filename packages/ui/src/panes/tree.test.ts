import { describe, expect, it } from 'vitest';
import { sizeText, switched, visibleBookmarks } from './tree';
import type { Bookmark, Layer } from './tree';

const mark = (title: string, depth: number, children = 0): Bookmark => ({ title, depth, page: 0, open: true, children });

describe('the bookmarks a person sees', () => {
  const items = [mark('1', 0, 2), mark('1.1', 1, 1), mark('1.1.1', 2), mark('1.2', 1), mark('2', 0)];

  it('are all of them while everything is open', () => {
    expect(visibleBookmarks(items, new Set()).map((v) => v.item.title)).toEqual(['1', '1.1', '1.1.1', '1.2', '2']);
  });

  it('skip what is under a closed entry, at any depth, and only that', () => {
    expect(visibleBookmarks(items, new Set([1])).map((v) => v.item.title)).toEqual(['1', '1.1', '1.2', '2']);
    expect(visibleBookmarks(items, new Set([0])).map((v) => v.item.title)).toEqual(['1', '2']);
    expect(visibleBookmarks(items, new Set([0])).map((v) => v.index)).toEqual([0, 4]);
  });
});

describe('switching a layer', () => {
  const layers: Layer[] = [
    { id: '10 0', name: 'Text', visible: true, locked: false, print: null, export: null },
    { id: '12 0', name: 'Watermark', visible: false, locked: false, print: true, export: null },
  ];

  it('shows the rest as they are, and that one the other way', () => {
    expect(switched(layers, '12 0')).toEqual(['10 0', '12 0']);
    expect(switched(layers, '10 0')).toEqual([]);
  });

  it('sizes read in either language', () => {
    expect(sizeText(18, 'en')).toBe('18 bytes');
    expect(sizeText(2048, 'ar')).toBe('2 ك.ب');
  });
});
