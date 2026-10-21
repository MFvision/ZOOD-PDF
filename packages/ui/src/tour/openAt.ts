/**
 * Where the tour's next opening starts: a chapter's id (the quick tools'
 * from Settings, Ask ZOOD's from the Help menu), else the first. Kept apart
 * from the tour itself so the menus can name a chapter without loading it.
 */

let startAt: string | null = null;

/** Opens the tour at one chapter (by id). */
export function openTourAt(id: string, open: () => void): void {
  startAt = id;
  open();
}

/** The chapter asked for, once: the opening after it starts at the first again. */
export function takeStartAt(): string | null {
  const id = startAt;
  startAt = null;
  return id;
}
