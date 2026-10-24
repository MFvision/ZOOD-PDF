import { describe, expect, it } from 'vitest';
import { DRIVE, DRIVE_UPLOAD, GoogleDrive, multipart, pickedIds, queryString, versionOf } from './gdrive';
import { authorised } from './http';
import { googleServer, Session } from './oauth';
import { bytesOf, countingBroker, recording, reply } from './testing';

const server = googleServer({ clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com' });
const ID = '1AbCdEfGhIjKlMnOpQrStUv';

function drive(handle: Parameters<typeof recording>[0]) {
  const { transport, seen } = recording(handle);
  return { gdrive: new GoogleDrive(authorised(new Session(server, countingBroker()), transport)), seen };
}

const file = (headRevisionId: string, extra: object = {}) => ({
  id: ID,
  name: 'عقد.pdf',
  mimeType: 'application/pdf',
  version: '7',
  headRevisionId,
  parents: ['0FolderIdAbcdef'],
  ...extra,
});

describe('Google Drive, as drive.file lets the app see it', () => {
  it('lists the PDFs and folders the app may open, searched by name with the text quoted', async () => {
    const folder = { id: '0FolderIdAbcdef', name: 'زود', mimeType: 'application/vnd.google-apps.folder' };
    const { gdrive, seen } = drive(() => reply(200, { files: [folder, file('r1', { size: '2048' })], nextPageToken: 'p2' }));
    const listing = await gdrive.list({ text: "O'Brien\\" });
    const url = new URL(seen[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe(`${DRIVE}/files`);
    expect(url.searchParams.get('q')).toBe(
      "(mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.folder') and trashed = false and name contains 'O\\'Brien\\\\'",
    );
    expect(listing).toEqual({
      entries: [
        { key: '0FolderIdAbcdef', name: 'زود', kind: 'folder', modified: undefined },
        { key: ID, name: 'عقد.pdf', kind: 'pdf', size: 2048, modified: undefined },
      ],
      next: 'p2',
    });
    await gdrive.list({}, 'p2');
    expect(new URL(seen[1]?.url ?? '').searchParams.get('pageToken')).toBe('p2');
    expect(queryString('a')).toBe("'a'");
  });

  it('lists what it may see in a picked folder, and refuses a malformed folder ID', async () => {
    const { gdrive, seen } = drive(() => reply(200, { files: [] }));
    await gdrive.list({ folder: '0FolderIdAbcdef' });
    expect(new URL(seen[0]?.url ?? '').searchParams.get('q')).toContain("and '0FolderIdAbcdef' in parents");
    await expect(gdrive.list({ folder: "x' or '1'='1" })).rejects.toMatchObject({ kind: 'notFound' });
    expect(seen).toHaveLength(1);
  });

  it('turns what the picker gave back into PDFs and folders, in the order picked, leaving out anything else', async () => {
    const byId: Record<string, object> = {
      '0FolderIdAbcdef': { id: '0FolderIdAbcdef', name: 'Contracts', mimeType: 'application/vnd.google-apps.folder' },
      [ID]: file('r1'),
      '1SheetIdAbcdefgh': { id: '1SheetIdAbcdefgh', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
      '1TrashedIdAbcdef': { ...file('r1'), id: '1TrashedIdAbcdef', trashed: true },
    };
    const { gdrive } = drive((request) => reply(200, byId[new URL(request.url).pathname.split('/').pop() ?? ''] ?? {}));
    expect(await gdrive.entries(['0FolderIdAbcdef', '1SheetIdAbcdefgh', ID, '1TrashedIdAbcdef'])).toEqual([
      { key: '0FolderIdAbcdef', name: 'Contracts', kind: 'folder' },
      { key: ID, name: 'عقد.pdf', kind: 'pdf' },
    ]);
  });

  it('opens a PDF: metadata for its revision, then its bytes (alt=media), both with the token', async () => {
    const { gdrive, seen } = drive((request) =>
      request.url.includes('alt=media') ? reply(200, new TextEncoder().encode('%PDF').buffer) : reply(200, file('r1')),
    );
    const opened = await gdrive.open(ID);
    expect(opened).toMatchObject({ key: ID, name: 'عقد.pdf', version: 'r1', parentKey: '0FolderIdAbcdef' });
    expect(seen.map((r) => r.headers?.authorization)).toEqual(['Bearer token-1', 'Bearer token-1']);
    expect(seen[1]?.url).toBe(`${DRIVE}/files/${ID}?alt=media&supportsAllDrives=true`);
  });

  it('refuses to open what is not a PDF, is in the trash, or is not a Drive ID', async () => {
    await expect(drive(() => reply(200, file('r1', { mimeType: 'application/vnd.google-apps.document' }))).gdrive.open(ID)).rejects.toMatchObject({
      kind: 'notFound',
    });
    await expect(drive(() => reply(200, file('r1', { trashed: true }))).gdrive.open(ID)).rejects.toMatchObject({ kind: 'notFound' });
    const { gdrive, seen } = drive(() => reply(200, file('r1')));
    await expect(gdrive.open('../../about')).rejects.toMatchObject({ kind: 'notFound' });
    expect(seen).toHaveLength(0);
  });

  it('saves a revision after checking the head revision is still the one opened, else says conflict and writes nothing', async () => {
    let head = 'r1';
    const { gdrive, seen } = drive((request) => {
      if (request.method === 'PATCH') {
        head = 'r2';
        return reply(200, file('r2'));
      }
      return reply(200, file(head));
    });
    const saved = await gdrive.saveRevision(ID, bytesOf(5), 'r1');
    expect(saved.version).toBe('r2');
    expect(seen[1]).toMatchObject({
      method: 'PATCH',
      url: `${DRIVE_UPLOAD}/files/${ID}?uploadType=media&supportsAllDrives=true&fields=${encodeURIComponent('id,name,mimeType,size,version,headRevisionId,modifiedTime,parents,trashed')}`,
      headers: { 'content-type': 'application/pdf', authorization: 'Bearer token-1' },
    });
    const before = seen.length;
    await expect(gdrive.saveRevision(ID, bytesOf(5), 'r1')).rejects.toMatchObject({ kind: 'conflict' });
    expect(seen.slice(before).map((r) => r.method)).toEqual(['GET']);
    // Replacing skips the check.
    await gdrive.saveRevision(ID, bytesOf(5), null);
    expect(seen.at(-1)?.method).toBe('PATCH');
  });

  it('creates a file in a folder as multipart/related: its metadata, then the PDF', async () => {
    const { gdrive, seen } = drive(() => reply(200, file('r1')));
    await gdrive.saveNew('0FolderIdAbcdef', 'عقد.pdf', new TextEncoder().encode('%PDF-1.7').buffer as ArrayBuffer);
    const request = seen[0];
    expect(request?.url.startsWith(`${DRIVE_UPLOAD}/files?uploadType=multipart`)).toBe(true);
    const boundary = /boundary=(\S+)/.exec(request?.headers?.['content-type'] ?? '')?.[1] ?? '';
    const body = new TextDecoder().decode(request?.body as ArrayBuffer);
    expect(body).toBe(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `{"name":"عقد.pdf","mimeType":"application/pdf","parents":["0FolderIdAbcdef"]}\r\n` +
        `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\r\n--${boundary}--\r\n`,
    );
  });

  it('never uses a boundary that occurs in the PDF', () => {
    const { contentType, body } = multipart({ name: 'x' }, bytesOf(100));
    const boundary = contentType.split('boundary=')[1] ?? '';
    expect(boundary).toMatch(/^warraq-[A-Za-z0-9]+$/);
    expect(new TextDecoder().decode(body).split(`--${boundary}`)).toHaveLength(4);
  });

  it('reads the IDs Google’s picker sent back, and only well-formed ones', () => {
    expect(pickedIds({ picked_file_ids: `${ID},  1ZyXwVuTsRqPo_-9,../x` })).toEqual([ID, '1ZyXwVuTsRqPo_-9']);
    expect(pickedIds({})).toEqual([]);
    expect(versionOf({ id: ID, name: 'x', version: '9' })).toBe('v9');
  });
});
