import { CloudError } from './errors';
import { failure, jsonOf, ok } from './http';
import type { Api } from './http';
import { randomToken } from './pkce';
import type { Account, Entry, Listing, Opened, Saved } from './drive';

/**
 * Google Drive through the Drive API v3, with the drive.file scope: the app
 * sees only the files the person picked in Google's picker or saved from
 * the app, so the list here is exactly those — the picker is where the rest
 * of the drive is browsed and searched.
 *
 * Drive v3 has no conditional write (no If-Match, no ETag on files), so a
 * save first reads the file's head revision and refuses (`conflict`) if it
 * is not the one the file had when it was opened. Between that read and the
 * write someone could still save — a window of one request, which OneDrive's
 * If-Match does not have; docs/cloud.md says so.
 */

export const DRIVE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const FIELDS = 'id,name,mimeType,size,version,headRevisionId,modifiedTime,parents,trashed';
const PDF = 'application/pdf';
const FOLDER = 'application/vnd.google-apps.folder';

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  version?: string;
  headRevisionId?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
}

const enc = encodeURIComponent;

/** A file ID as Google makes them; anything else never reaches a URL. */
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

function checkedId(id: string): string {
  if (!FILE_ID.test(id)) throw new CloudError('notFound', 'not a Google Drive file ID');
  return id;
}

/** The content revision a save is checked against: the head revision, else the file's version. */
export function versionOf(file: DriveFile): string {
  return file.headRevisionId ?? (file.version ? `v${file.version}` : '');
}

function savedOf(file: DriveFile): Saved {
  return { key: file.id, name: file.name, version: versionOf(file), parentKey: file.parents?.[0] ?? null };
}

/** A string inside a Drive query: quotes and backslashes escaped with a backslash. */
export function queryString(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The IDs Google's picker sent back in the redirect (`picked_file_ids`), in order, checked. */
export function pickedIds(params: Record<string, string>): string[] {
  return (params.picked_file_ids ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => FILE_ID.test(id));
}

/**
 * A `multipart/related` body: the metadata as JSON, then the PDF. The
 * boundary is drawn again in the unlikely case the PDF contains it.
 */
export function multipart(metadata: object, bytes: ArrayBuffer): { body: ArrayBuffer; contentType: string } {
  const data = new Uint8Array(bytes);
  const encoder = new TextEncoder();
  let boundary: string;
  do boundary = `warraq-${randomToken(32).replace(/[^A-Za-z0-9]/g, '')}`;
  while (contains(data, encoder.encode(boundary)));
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${PDF}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + data.length + tail.length);
  body.set(head, 0);
  body.set(data, head.length);
  body.set(tail, head.length + data.length);
  return { body: body.buffer, contentType: `multipart/related; boundary=${boundary}` };
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    for (let k = 0; k < needle.length; k += 1) if (haystack[at + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

export class GoogleDrive {
  constructor(private readonly api: Api) {}

  async account(): Promise<Account> {
    const response = await this.api({ method: 'GET', url: `${DRIVE}/about?fields=${enc('user(displayName,emailAddress)')}` });
    if (!ok(response)) throw failure(response, 'about');
    const { user } = jsonOf<{ user?: { displayName?: string; emailAddress?: string } }>(response);
    return { name: user?.displayName ?? '', email: user?.emailAddress ?? '' };
  }

  /** The PDFs the app can open (picked or saved from it), newest first, whose name contains `text` if given. */
  async list(text: string | null, next?: string | null): Promise<Listing> {
    const terms = [`mimeType = '${PDF}'`, 'trashed = false'];
    if (text) terms.push(`name contains ${queryString(text)}`);
    const params = new URLSearchParams({
      q: terms.join(' and '),
      fields: `nextPageToken,files(${FIELDS})`,
      orderBy: 'modifiedTime desc',
      pageSize: '100',
      spaces: 'drive',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (next) params.set('pageToken', next);
    const response = await this.api({ method: 'GET', url: `${DRIVE}/files?${params}` });
    if (!ok(response)) throw failure(response, 'list');
    const body = jsonOf<{ files?: DriveFile[]; nextPageToken?: string }>(response);
    const entries: Entry[] = (body.files ?? []).map((file) => ({
      key: file.id,
      name: file.name,
      kind: 'pdf',
      size: file.size ? Number(file.size) : undefined,
      modified: file.modifiedTime,
    }));
    return { entries, next: typeof body.nextPageToken === 'string' ? body.nextPageToken : null };
  }

  async metadata(id: string): Promise<DriveFile> {
    const response = await this.api({
      method: 'GET',
      url: `${DRIVE}/files/${enc(checkedId(id))}?fields=${enc(FIELDS)}&supportsAllDrives=true`,
    });
    if (!ok(response)) throw failure(response, 'metadata');
    return jsonOf<DriveFile>(response);
  }

  async open(id: string): Promise<Opened> {
    const file = await this.metadata(id);
    if (file.trashed) throw new CloudError('notFound', 'in the trash');
    if (file.mimeType !== PDF) throw new CloudError('notFound', 'not a PDF');
    const content = await this.api({
      method: 'GET',
      url: `${DRIVE}/files/${enc(file.id)}?alt=media&supportsAllDrives=true`,
    });
    if (!ok(content)) throw failure(content, 'download');
    return { ...savedOf(file), bytes: content.body };
  }

  /**
   * A new revision of the file. With `expected`, refused (`conflict`) when
   * the file's head revision is not that any more.
   */
  async saveRevision(id: string, bytes: ArrayBuffer, expected: string | null): Promise<Saved> {
    if (expected !== null && versionOf(await this.metadata(id)) !== expected) {
      throw new CloudError('conflict', 'the head revision changed');
    }
    const response = await this.api({
      method: 'PATCH',
      url: `${DRIVE_UPLOAD}/files/${enc(checkedId(id))}?uploadType=media&supportsAllDrives=true&fields=${enc(FIELDS)}`,
      headers: { 'content-type': PDF },
      body: bytes,
    });
    if (!ok(response)) throw failure(response, 'update');
    return savedOf(jsonOf<DriveFile>(response));
  }

  /**
   * A new file in the folder `folderId` (`null`: My Drive). Drive allows two
   * files of one name, so there is no name to be taken.
   */
  async saveNew(folderId: string | null, name: string, bytes: ArrayBuffer): Promise<Saved> {
    const metadata = { name, mimeType: PDF, ...(folderId ? { parents: [checkedId(folderId)] } : {}) };
    const { body, contentType } = multipart(metadata, bytes);
    const response = await this.api({
      method: 'POST',
      url: `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${enc(FIELDS)}`,
      headers: { 'content-type': contentType },
      body,
    });
    if (!ok(response)) throw failure(response, 'create');
    return savedOf(jsonOf<DriveFile>(response));
  }

  /** Whether an ID the picker gave back is a folder the app may save into. */
  async isFolder(id: string): Promise<boolean> {
    return (await this.metadata(id)).mimeType === FOLDER;
  }
}
