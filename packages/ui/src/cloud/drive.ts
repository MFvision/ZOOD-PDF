/**
 * What the interface knows of a drive, the same for OneDrive and Google
 * Drive: an item is a `key` the drive's own code made (and alone reads), a
 * saved file carries the `version` its next save is checked against.
 */

/** The signed-in person, as the drive names them. */
export interface Account {
  name: string;
  email: string;
}

export interface Entry {
  key: string;
  name: string;
  kind: 'folder' | 'pdf';
  size?: number;
  /** ISO 8601. */
  modified?: string;
  /** A folder's count of items, when the drive says. */
  children?: number;
  /** Where a search found it, as a path under the drive's top. */
  location?: string;
}

export interface Listing {
  entries: Entry[];
  /** The next page, when there is one; fetched only when the person asks for more. */
  next: string | null;
}

/** A file as it now stands in the drive. */
export interface Saved {
  key: string;
  name: string;
  /**
   * What a later save is checked against: OneDrive's eTag, Google Drive's
   * head revision. A file saved by someone else since has another.
   */
  version: string;
  /** Its folder, when the drive says (a copy is offered there). */
  parentKey: string | null;
  /** That folder's name, when the drive says. */
  parentName?: string | null;
}

export interface Opened extends Saved {
  bytes: ArrayBuffer;
}
