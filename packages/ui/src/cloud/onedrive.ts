import { CloudError } from './errors';
import { failure, jsonOf, ok } from './http';
import type { Api, CloudResponse } from './http';
import type { Account, Entry, Listing, Opened, Saved } from './drive';

/**
 * OneDrive through Microsoft Graph v1.0, personal and work or school.
 *
 * Downloads use the item's `@microsoft.graph.downloadUrl`, not `/content`:
 * `/content` answers with a redirect, which a browser may not follow after
 * the CORS preflight a bearer token needs; the download URL is
 * pre-authenticated and is fetched with no token at all.
 *
 * Every save goes through an upload session, because that is where Graph
 * documents both guards: `If-Match` with the eTag the file had when it was
 * opened (a 412 means someone saved it since: a conflict, never overwritten
 * silently), and `@microsoft.graph.conflictBehavior` for a new file (a 409
 * means the name is taken). The bytes go to the session's pre-authenticated
 * upload URL, again with no token, in ranges of 10 MiB — multiples of the
 * 320 KiB Graph requires — so files of any size are saved the same way.
 */

export const GRAPH = 'https://graph.microsoft.com/v1.0';

/** 32 × 320 KiB. */
export const UPLOAD_RANGE = 32 * 320 * 1024;

/** An item: in a drive that is not the person's own (a shared folder's shortcut), with that drive's ID. */
export interface ItemRef {
  driveId: string | null;
  itemId: string;
}

interface GraphItem {
  id: string;
  name: string;
  eTag?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  package?: unknown;
  parentReference?: { driveId?: string; id?: string; name?: string; path?: string };
  remoteItem?: GraphItem;
  '@microsoft.graph.downloadUrl'?: string;
}

const SELECT = 'id,name,size,file,folder,package,remoteItem,parentReference,lastModifiedDateTime,eTag';

const enc = encodeURIComponent;

function itemPath(ref: ItemRef): string {
  return ref.driveId ? `/drives/${enc(ref.driveId)}/items/${enc(ref.itemId)}` : `/me/drive/items/${enc(ref.itemId)}`;
}

/** An item's key for the app's own lists: the drive and the item. */
export function oneDriveKey(ref: ItemRef): string {
  return `${ref.driveId ?? 'me'}!${ref.itemId}`;
}

export function refOfKey(key: string): ItemRef | null {
  const at = key.indexOf('!');
  if (at < 1 || at === key.length - 1) return null;
  const driveId = key.slice(0, at);
  return { driveId: driveId === 'me' ? null : driveId, itemId: key.slice(at + 1) };
}

function isPdfItem(item: GraphItem): boolean {
  return Boolean(item.file) && (item.file?.mimeType === 'application/pdf' || /\.pdf$/i.test(item.name));
}

/**
 * A folder or a PDF as the browser lists it; anything else (other files,
 * OneNote notebooks) is left out. A shortcut to someone else's item is
 * listed as that item, in its own drive.
 */
export function entryOf(item: GraphItem): Entry | null {
  const target = item.remoteItem ?? item;
  const ref: ItemRef = { driveId: target.parentReference?.driveId ?? item.parentReference?.driveId ?? null, itemId: target.id };
  const key = oneDriveKey(ref);
  const modified = target.lastModifiedDateTime ?? item.lastModifiedDateTime;
  if (target.package || item.package) return null;
  if (target.folder || item.folder) {
    return { key, name: item.name, kind: 'folder', children: (target.folder ?? item.folder)?.childCount, modified };
  }
  if (isPdfItem(target) || isPdfItem(item)) {
    const path = item.parentReference?.path;
    // "/drive/root:/Reports/2026" → "Reports/2026", for search results.
    const location = path?.includes('root:') ? decodeURIComponent(path.slice(path.indexOf('root:') + 5)).replace(/^\//, '') : undefined;
    return { key, name: item.name, kind: 'pdf', size: target.size ?? item.size, modified, location };
  }
  return null;
}

function listing(response: CloudResponse, what: string): Listing {
  if (!ok(response)) throw failure(response, what);
  const body = jsonOf<{ value?: GraphItem[]; '@odata.nextLink'?: string }>(response);
  const entries = (body.value ?? []).map(entryOf).filter((entry): entry is Entry => entry !== null);
  const next = body['@odata.nextLink'];
  // Only a page of Graph's own is followed.
  return { entries, next: typeof next === 'string' && next.startsWith(`${GRAPH}/`) ? next : null };
}

/** Graph's search takes its text in quotes; a quote inside is doubled (OData). */
export function searchUrl(text: string): string {
  const quoted = text.replace(/'/g, "''");
  return `${GRAPH}/me/drive/root/search(q='${enc(quoted)}')?$select=${SELECT}&$top=200`;
}

/**
 * Characters OneDrive refuses in a name, and names it reserves. A name is
 * made safe rather than refused: the person sees what it became.
 */
export function oneDriveName(name: string): string {
  const cleaned = [...name]
    .filter((ch) => ch >= ' ')
    .join('')
    .replace(/["*:<>?/\\|]/g, '-')
    .trim()
    .replace(/[. ]+$/, '');
  const pdf = /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned || 'document'}.pdf`;
  return /^(con|prn|aux|nul|com\d|lpt\d|desktop\.ini|_vti_.*)(\.pdf)?$/i.test(pdf) ? `_${pdf}` : pdf;
}

function savedOf(item: GraphItem, fallback: ItemRef): Saved {
  const ref: ItemRef = { driveId: item.parentReference?.driveId ?? fallback.driveId, itemId: item.id };
  return {
    key: oneDriveKey(ref),
    name: item.name,
    version: item.eTag ?? '',
    parentKey: item.parentReference?.id ? oneDriveKey({ driveId: ref.driveId, itemId: item.parentReference.id }) : null,
    parentName: item.parentReference?.name ?? null,
  };
}

export class OneDrive {
  /**
   * `api` carries the bearer token (`authorised`); `plain` carries none, for
   * the pre-authenticated download and upload addresses.
   */
  constructor(
    private readonly api: Api,
    private readonly plain: Api,
  ) {}

  async account(): Promise<Account> {
    const response = await this.api({ method: 'GET', url: `${GRAPH}/me?$select=displayName,mail,userPrincipalName` });
    if (!ok(response)) throw failure(response, 'me');
    const me = jsonOf<{ displayName?: string; mail?: string | null; userPrincipalName?: string }>(response);
    return { name: me.displayName ?? '', email: me.mail ?? me.userPrincipalName ?? '' };
  }

  /** A folder's folders and PDFs (`null`: the top of the person's drive), or the page after `next`. */
  async list(folderKey: string | null, next?: string | null): Promise<Listing> {
    const folder = folderKey ? refOfKey(folderKey) : null;
    if (folderKey && !folder) throw new CloudError('notFound', 'not a OneDrive folder');
    const url = next ?? `${GRAPH}${folder ? itemPath(folder) : '/me/drive/root'}/children?$select=${SELECT}&$top=200`;
    return listing(await this.api({ method: 'GET', url }), 'list');
  }

  /** Folders and PDFs anywhere in the drive whose name or text matches. */
  async search(text: string, next?: string | null): Promise<Listing> {
    return listing(await this.api({ method: 'GET', url: next ?? searchUrl(text) }), 'search');
  }

  /** The file's bytes, and the eTag a save will be checked against. */
  async open(key: string): Promise<Opened> {
    const ref = refOfKey(key);
    if (!ref) throw new CloudError('notFound', 'not a OneDrive file');
    const response = await this.api({ method: 'GET', url: `${GRAPH}${itemPath(ref)}` });
    if (!ok(response)) throw failure(response, 'item');
    const item = jsonOf<GraphItem>(response);
    if (!item.file) throw new CloudError('notFound', 'not a file');
    const download = item['@microsoft.graph.downloadUrl'];
    if (!download) throw new CloudError('server', 'no download address');
    const content = await this.plain({ method: 'GET', url: download });
    if (!ok(content)) throw failure(content, 'download');
    return { ...savedOf(item, ref), bytes: content.body };
  }

  /**
   * A new revision of the file at `key`. With `ifMatch`, refused with
   * `conflict` if the file's eTag is not that any more — someone saved it
   * since. Without, it replaces whatever is there (OneDrive keeps the
   * earlier version in the file's history).
   */
  async saveRevision(key: string, bytes: ArrayBuffer, ifMatch: string | null): Promise<Saved> {
    const ref = refOfKey(key);
    if (!ref) throw new CloudError('notFound', 'not a OneDrive file');
    const response = await this.api({
      method: 'POST',
      url: `${GRAPH}${itemPath(ref)}/createUploadSession`,
      headers: { 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });
    if (!ok(response)) throw failure(response, 'createUploadSession');
    return this.upload(response, bytes, ref);
  }

  /**
   * A new file `name` in the folder at `folderKey` (`null`: the top of the
   * drive). `fail` refuses a name already there with `nameTaken`; `replace`
   * replaces that file; `rename` lets OneDrive number this one.
   */
  async saveNew(folderKey: string | null, name: string, bytes: ArrayBuffer, behavior: 'fail' | 'replace' | 'rename'): Promise<Saved> {
    const folder = folderKey ? refOfKey(folderKey) : null;
    if (folderKey && !folder) throw new CloudError('notFound', 'not a OneDrive folder');
    const safe = oneDriveName(name);
    const parent = folder ? itemPath(folder) : '/me/drive/root';
    const response = await this.api({
      method: 'POST',
      url: `${GRAPH}${parent}:/${enc(safe)}:/createUploadSession`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': behavior, name: safe } }),
    });
    if (!ok(response)) throw failure(response, 'createUploadSession');
    return this.upload(response, bytes, folder ?? { driveId: null, itemId: 'root' });
  }

  private async upload(session: CloudResponse, bytes: ArrayBuffer, around: ItemRef): Promise<Saved> {
    const { uploadUrl } = jsonOf<{ uploadUrl?: string }>(session);
    if (typeof uploadUrl !== 'string' || !uploadUrl.startsWith('https://')) throw new CloudError('server', 'no upload address');
    const total = bytes.byteLength;
    if (total === 0) throw new CloudError('server', 'nothing to upload');
    for (let start = 0; start < total; start += UPLOAD_RANGE) {
      const end = Math.min(start + UPLOAD_RANGE, total);
      const response = await this.plain({
        method: 'PUT',
        url: uploadUrl,
        headers: { 'content-range': `bytes ${start}-${end - 1}/${total}` },
        body: bytes.slice(start, end),
      });
      if (response.status === 202 && end < total) continue;
      if (response.status === 200 || response.status === 201) return savedOf(jsonOf<GraphItem>(response), around);
      // A failed session is removed rather than left until it expires.
      await this.plain({ method: 'DELETE', url: uploadUrl }).catch(() => undefined);
      throw failure(response, 'upload');
    }
    throw new CloudError('server', 'the upload session never completed');
  }
}
