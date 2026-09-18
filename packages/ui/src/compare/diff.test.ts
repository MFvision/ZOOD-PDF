import { describe, expect, it } from 'vitest';
import { MAX_EDITS, diffWords, editScript, joinShortRuns } from './diff';
import type { Segment } from './diff';

const words = (text: string) => text.split(' ').filter(Boolean);

/** A diff as a person would mark it up: [-removed-] {+added+}. */
function show(older: string[], newer: string[], segments: readonly Segment[]): string {
  return segments
    .map((segment) => {
      if (segment.kind === 'same') return newer.slice(...segment.newer).join(' ');
      const removed = older.slice(...segment.older).join(' ');
      const added = newer.slice(...segment.newer).join(' ');
      return [removed && `[-${removed}-]`, added && `{+${added}+}`].filter(Boolean).join(' ');
    })
    .join(' ');
}

function diff(older: string, newer: string): string {
  const a = words(older);
  const b = words(newer);
  return show(a, b, diffWords(a, b));
}

/** The segments cover both sequences end to end, in order, and matching runs really match. */
function expectValid(a: readonly string[], b: readonly string[], segments: readonly Segment[]): void {
  let x = 0;
  let y = 0;
  for (const segment of segments) {
    expect(segment.older[0]).toBe(x);
    expect(segment.newer[0]).toBe(y);
    const olderLength = segment.older[1] - segment.older[0];
    const newerLength = segment.newer[1] - segment.newer[0];
    expect(olderLength + newerLength).toBeGreaterThan(0);
    if (segment.kind === 'same') {
      expect(newerLength).toBe(olderLength);
      expect(b.slice(...segment.newer)).toEqual(a.slice(...segment.older));
    }
    x = segment.older[1];
    y = segment.newer[1];
  }
  expect([x, y]).toEqual([a.length, b.length]);
  // Runs alternate: two of a kind in a row would be one.
  for (let i = 1; i < segments.length; i += 1) expect(segments[i]!.kind).not.toBe(segments[i - 1]!.kind);
}

/** Longest common subsequence, by the textbook table: what a minimal script keeps. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const next = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = a[i - 1] === b[j - 1] ? row[j - 1]! + 1 : Math.max(row[j]!, next[j - 1]!);
    }
    row = next;
  }
  return row[b.length]!;
}

/** A small seeded generator (mulberry32), so a failure can be replayed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the word diff', () => {
  it('finds nothing to mark in the same words', () => {
    expect(diffWords(words('صباح الخير يا عالم'), words('صباح الخير يا عالم'))).toEqual([
      { kind: 'same', older: [0, 4], newer: [0, 4] },
    ]);
  });

  it('marks words inserted', () => {
    expect(diff('صباح الخير', 'صباح الخير يا عالم')).toBe('صباح الخير {+يا عالم+}');
    expect(diff('الخير يا عالم', 'صباح الخير يا عالم')).toBe('{+صباح+} الخير يا عالم');
    expect(diff('صباح عالم', 'صباح الخير يا عالم')).toBe('صباح {+الخير يا+} عالم');
  });

  it('marks words removed', () => {
    expect(diff('صباح الخير يا عالم', 'صباح عالم')).toBe('صباح [-الخير يا-] عالم');
    expect(diff('صباح الخير يا عالم', 'الخير يا عالم')).toBe('[-صباح-] الخير يا عالم');
  });

  it('marks a word replaced as removed, then added', () => {
    expect(diff('يدفع المستأجر ألف ريال شهريا', 'يدفع المستأجر ألفي ريال شهريا')).toBe(
      'يدفع المستأجر [-ألف-] {+ألفي+} ريال شهريا',
    );
  });

  it('handles empty inputs', () => {
    expect(diffWords([], [])).toEqual([]);
    expect(diffWords([], words('كلمة جديدة'))).toEqual([{ kind: 'changed', older: [0, 0], newer: [0, 2] }]);
    expect(diffWords(words('كلمة قديمة'), [])).toEqual([{ kind: 'changed', older: [0, 2], newer: [0, 0] }]);
  });

  it('keeps Arabic and Latin words apart, in logical order', () => {
    expect(diff('تقرير البنك الدولي World Bank 2021', 'تقرير البنك الدولي World Bank 2022')).toBe(
      'تقرير البنك الدولي World Bank [-2021-] {+2022+}',
    );
  });

  it('reads a rewritten sentence as one change, not as pieces around a shared word', () => {
    // The shortest script keeps "في" and splits the rewrite around it…
    const a = words('اجتمع الوزراء أمس في العاصمة الجديدة');
    const b = words('وصل الرئيس اليوم في موكب رسمي');
    expect(show(a, b, editScript(a, b))).toBe('[-اجتمع الوزراء أمس-] {+وصل الرئيس اليوم+} في [-العاصمة الجديدة-] {+موكب رسمي+}');
    // …a person reads it as one sentence replaced by another.
    expect(show(a, b, diffWords(a, b))).toBe(
      '[-اجتمع الوزراء أمس في العاصمة الجديدة-] {+وصل الرئيس اليوم في موكب رسمي+}',
    );
  });

  it('keeps a shared run that is not shorter than the changes around it', () => {
    expect(diff('أ ب ج د هـ', 'س ب ج د ص')).toBe('[-أ-] {+س+} ب ج د [-هـ-] {+ص+}');
    const kept: Segment[] = [
      { kind: 'changed', older: [0, 1], newer: [0, 1] },
      { kind: 'same', older: [1, 2], newer: [1, 2] },
      { kind: 'changed', older: [2, 3], newer: [2, 3] },
    ];
    expect(joinShortRuns(kept)).toEqual(kept);
  });

  it('is a minimal, valid script on thousands of random pairs', () => {
    const next = random(20260918);
    for (let trial = 0; trial < 3000; trial += 1) {
      const alphabet = ['في', 'من', 'على', 'الله', 'ا', 'ب'].slice(0, 2 + Math.floor(next() * 4));
      const pick = () => alphabet[Math.floor(next() * alphabet.length)]!;
      const a = Array.from({ length: Math.floor(next() * 14) }, pick);
      const b = Array.from({ length: Math.floor(next() * 14) }, pick);
      const script = editScript(a, b);
      expectValid(a, b, script);
      const kept = script.filter((s) => s.kind === 'same').reduce((sum, s) => sum + s.older[1] - s.older[0], 0);
      expect(kept, `${a.join(',')} → ${b.join(',')}`).toBe(lcsLength(a, b));
      expectValid(a, b, diffWords(a, b));
    }
  });

  it('marks the unmatched middle as one change past its edit limit, and stays valid', () => {
    const a = words('أ ب ج د هـ و ز');
    const b = words('أ س ش ص ض ط ز');
    const script = editScript(a, b, 2);
    expectValid(a, b, script);
    expect(show(a, b, script)).toBe('أ [-ب ج د هـ و-] {+س ش ص ض ط+} ز');
  });

  it('compares a long page with changes at both ends quickly', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `كلمة${i % 97}`);
    const older = ['عنوان', ...body, 'صفحة ١'];
    const newer = ['العنوان', ...body.slice(0, 1500), 'إضافة', ...body.slice(1500), 'صفحة ٢'];
    const started = performance.now();
    const segments = diffWords(older, newer);
    expect(performance.now() - started).toBeLessThan(1000);
    expectValid(older, newer, segments);
    expect(segments.filter((s) => s.kind === 'changed')).toHaveLength(3);
  });

  it('gives up on two unrelated long pages without running out of memory', () => {
    const older = Array.from({ length: 4000 }, (_, i) => `أ${i}`);
    const newer = Array.from({ length: 4000 }, (_, i) => `ب${i}`);
    const segments = diffWords(older, newer);
    expect(segments).toEqual([{ kind: 'changed', older: [0, 4000], newer: [0, 4000] }]);
    expect(MAX_EDITS).toBeLessThan(older.length + newer.length);
  });
});
