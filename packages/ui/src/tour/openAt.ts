/**
 * Where the tour's next opening starts: a chapter's id (the quick tools'
 * from Settings, Ask ZOOD's from the Help menu), else the first. Kept apart
 * from the tour itself so the menus can name a chapter without loading it.
 */

let startAt: string | null = null;
let startPart: string | null = null;

/** Opens the tour at one chapter (by id), and at one of its parts when it has them. */
export function openTourAt(id: string, open: () => void, part: string | null = null): void {
  startAt = id;
  startPart = part;
  open();
}

/** The part of the chapter asked for, once (Ask ZOOD's Show me and do it). */
export function takeStartPart(): string | null {
  const part = startPart;
  startPart = null;
  return part;
}

/** The chapter asked for, once: the opening after it starts at the first again. */
export function takeStartAt(): string | null {
  const id = startAt;
  startAt = null;
  return id;
}
