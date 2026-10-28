/**
 * Changes to the file still under way. A save waits for them: clicking Save
 * while an Arabic edit was still finding its font saved the file without it.
 */
export function changesUnderWay() {
  const all = new Set<Promise<unknown>>();
  return {
    track<T>(change: Promise<T>): Promise<T> {
      all.add(change);
      void change.finally(() => all.delete(change)).catch(() => undefined);
      return change;
    },
    /** Resolves once every change started so far has finished, failed ones too. */
    async settled(): Promise<void> {
      await Promise.allSettled([...all]);
    },
  };
}
