import { describe, expect, it } from 'vitest';
import { CloudError } from './errors';
import { authorised, hostTransport, unauthorised } from './http';
import type { CloudRequest } from './http';
import { oneDriveServer, Session } from './oauth';
import { GRAPH, OneDrive, UPLOAD_RANGE, entryOf, oneDriveKey, oneDriveName, refOfKey, searchUrl } from './onedrive';
import { bytesOf, countingBroker, recording, reply } from './testing';

const server = oneDriveServer({ clientId: '0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22', tenant: 'common' });
const UPLOAD = 'https://sn3302.up.1drv.com/up/session-1';

function drive(handle: Parameters<typeof recording>[0]) {
  const { transport, seen } = recording(handle);
  const broker = countingBroker();
  const session = new Session(server, broker);
  return { onedrive: new OneDrive(authorised(session, transport), unauthorised('onedrive', transport)), seen, broker };
}

const auth = (request: CloudRequest) => request.headers?.authorization;

describe('listing and searching OneDrive', () => {
  it('lists folders and PDFs, leaves other files out, and follows a shortcut to its own drive', async () => {
    const { onedrive, seen } = drive(() =>
      reply(200, {
        value: [
          { id: 'F1', name: 'Reports', folder: { childCount: 3 }, parentReference: { driveId: 'd1' } },
          { id: 'P1', name: 'فاتورة.pdf', size: 1200, file: { mimeType: 'application/pdf' }, parentReference: { driveId: 'd1' } },
          { id: 'P2', name: 'scan.PDF', file: { mimeType: 'application/octet-stream' }, parentReference: { driveId: 'd1' } },
          { id: 'X1', name: 'notes.docx', file: { mimeType: 'application/vnd.openxmlformats' } },
          { id: 'N1', name: 'Notebook', package: { type: 'oneNote' }, folder: {} },
          { id: 'S1', name: 'Shared', remoteItem: { id: 'R9', name: 'Shared', folder: { childCount: 1 }, parentReference: { driveId: 'other' } } },
        ],
        '@odata.nextLink': `${GRAPH}/me/drive/root/children?$skiptoken=2`,
      }),
    );
    const listing = await onedrive.list(null);
    expect(seen[0]?.url).toBe(
      `${GRAPH}/me/drive/root/children?$select=id,name,size,file,folder,package,remoteItem,parentReference,lastModifiedDateTime,eTag&$top=200`,
    );
    expect(auth(seen[0] as CloudRequest)).toBe('Bearer token-1');
    expect(listing.entries.map((e) => [e.name, e.kind, e.key])).toEqual([
      ['Reports', 'folder', 'd1!F1'],
      ['فاتورة.pdf', 'pdf', 'd1!P1'],
      ['scan.PDF', 'pdf', 'd1!P2'],
      ['Shared', 'folder', 'other!R9'],
    ]);
    expect(listing.next).toBe(`${GRAPH}/me/drive/root/children?$skiptoken=2`);
    await onedrive.list('d1!F1');
    expect(seen[1]?.url.startsWith(`${GRAPH}/drives/d1/items/F1/children?`)).toBe(true);
  });

  it('follows only a next page on Graph itself', async () => {
    const { onedrive } = drive(() => reply(200, { value: [], '@odata.nextLink': 'https://evil.example/page2' }));
    expect((await onedrive.list(null)).next).toBeNull();
  });

  it('quotes search text the OData way', () => {
    expect(searchUrl("O'Brien & co")).toBe(
      `${GRAPH}/me/drive/root/search(q='O''Brien%20%26%20co')?$select=id,name,size,file,folder,package,remoteItem,parentReference,lastModifiedDateTime,eTag&$top=200`,
    );
    expect(entryOf({ id: 'P', name: 'a.pdf', file: {}, parentReference: { driveId: 'd', path: '/drive/root:/Reports/2026%20Q1' } })?.location).toBe(
      'Reports/2026 Q1',
    );
  });

  it('keys items by drive and item, and reads back only its own keys', () => {
    expect(refOfKey('d1!F1')).toEqual({ driveId: 'd1', itemId: 'F1' });
    expect(refOfKey('me!root')).toEqual({ driveId: null, itemId: 'root' });
    expect(refOfKey('nokey')).toBeNull();
    expect(refOfKey('!x')).toBeNull();
  });

  it('reads back keys of personal and of work or school drives, whose IDs both carry "!"', () => {
    // Personal: the drive ID has none, the item ID has one.
    const personal = { driveId: '8a2f1c0de4b3a9f0', itemId: '8A2F1C0DE4B3A9F0!1234' };
    expect(refOfKey(oneDriveKey(personal))).toEqual(personal);
    // Work or school (SharePoint): the drive ID starts "b!", the item ID has none.
    const work = { driveId: 'b!xX9_a-Rk2E2Qm5hYk3pT0wV7nL8sZ1cD4fG6hJ9kLmNoPqRsTuVwXyZ0123456', itemId: '01ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' };
    expect(refOfKey(oneDriveKey(work))).toEqual(work);
    expect(refOfKey('b!')).toBeNull();
  });

  it('lists a work or school folder in its own drive', async () => {
    const urls: string[] = [];
    const { onedrive } = drive((request) => {
      urls.push(request.url);
      return reply(200, { value: [] });
    });
    const driveId = 'b!xX9_a-Rk2E2Qm5hYk3pT0wV7nL8sZ1cD4fG6hJ9kLmNoPqRsTuVwXyZ0123456';
    const top = entryOf({ id: '01FOLDER', name: 'zood brochure بروفايل زود', folder: { childCount: 3 }, parentReference: { driveId } })!;
    await onedrive.list(top.key);
    expect(urls[0]).toBe(`${GRAPH}/drives/${encodeURIComponent(driveId)}/items/01FOLDER/children?$select=${'id,name,size,file,folder,package,remoteItem,parentReference,lastModifiedDateTime,eTag'}&$top=200`);
  });
});

describe('opening a OneDrive file', () => {
  it('reads the item with the token, then downloads from its pre-authenticated address without one', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 test').buffer as ArrayBuffer;
    const { onedrive, seen } = drive((request) =>
      request.url.startsWith(GRAPH)
        ? reply(200, {
            id: 'P1',
            name: 'فاتورة.pdf',
            eTag: '"{E1},1"',
            file: { mimeType: 'application/pdf' },
            parentReference: { driveId: 'd1', id: 'F1' },
            '@microsoft.graph.downloadUrl': 'https://public.am.files.1drv.com/y4m-download',
          })
        : reply(200, pdf),
    );
    const opened = await onedrive.open('d1!P1');
    expect(seen.map((r) => [r.method, r.url, auth(r)])).toEqual([
      ['GET', `${GRAPH}/drives/d1/items/P1`, 'Bearer token-1'],
      ['GET', 'https://public.am.files.1drv.com/y4m-download', undefined],
    ]);
    expect(opened).toMatchObject({ key: 'd1!P1', name: 'فاتورة.pdf', version: '"{E1},1"', parentKey: 'd1!F1' });
    expect(new TextDecoder().decode(opened.bytes)).toBe('%PDF-1.7 test');
  });

  it('refreshes once when the token is refused, and says a missing file is missing', async () => {
    let calls = 0;
    const { onedrive, broker } = drive(() => (++calls === 1 ? reply(401, { error: { code: 'InvalidAuthenticationToken' } }) : reply(404, { error: { code: 'itemNotFound' } })));
    await expect(onedrive.open('d1!gone')).rejects.toMatchObject({ kind: 'notFound' });
    expect(broker.refreshes).toBe(2);
  });
});

describe('saving to OneDrive', () => {
  function uploader(first: number, final = 201) {
    return drive((request) => {
      if (request.url.endsWith('/createUploadSession')) return first === 200 ? reply(200, { uploadUrl: UPLOAD }) : reply(first, { error: { code: first === 412 ? 'resourceModified' : 'nameAlreadyExists' } });
      const range = request.headers?.['content-range'] ?? '';
      const [, , end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range) ?? [];
      if (Number(end) + 1 < Number(total)) return reply(202, { nextExpectedRanges: [`${Number(end) + 1}-`] });
      return reply(final, { id: 'P1', name: 'فاتورة.pdf', eTag: '"{E1},2"', parentReference: { driveId: 'd1', id: 'F1' } });
    });
  }

  it('saves a revision only if the file still has the eTag it was opened with, in 320 KiB-multiple ranges, with no token on the upload', async () => {
    const { onedrive, seen } = uploader(200);
    const total = UPLOAD_RANGE * 2 + 1000;
    const saved = await onedrive.saveRevision('d1!P1', bytesOf(total), '"{E1},1"');
    expect(saved).toMatchObject({ key: 'd1!P1', version: '"{E1},2"' });
    const [session, ...puts] = seen;
    expect(session).toMatchObject({ method: 'POST', url: `${GRAPH}/drives/d1/items/P1/createUploadSession` });
    expect(session?.headers?.['if-match']).toBe('"{E1},1"');
    expect(auth(session as CloudRequest)).toBe('Bearer token-1');
    expect(UPLOAD_RANGE % (320 * 1024)).toBe(0);
    expect(puts.map((r) => [r.method, r.url, r.headers?.['content-range'], auth(r), (r.body as ArrayBuffer).byteLength])).toEqual([
      ['PUT', UPLOAD, `bytes 0-${UPLOAD_RANGE - 1}/${total}`, undefined, UPLOAD_RANGE],
      ['PUT', UPLOAD, `bytes ${UPLOAD_RANGE}-${2 * UPLOAD_RANGE - 1}/${total}`, undefined, UPLOAD_RANGE],
      ['PUT', UPLOAD, `bytes ${2 * UPLOAD_RANGE}-${total - 1}/${total}`, undefined, 1000],
    ]);
  });

  it('refuses a revision when someone saved the file since (412), without uploading anything', async () => {
    const { onedrive, seen } = uploader(412);
    const error = await onedrive.saveRevision('d1!P1', bytesOf(10), '"{E1},1"').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudError);
    expect((error as CloudError).kind).toBe('conflict');
    expect(seen).toHaveLength(1);
  });

  it('replaces whatever is there when asked to, with no If-Match', async () => {
    const { onedrive, seen } = uploader(200);
    await onedrive.saveRevision('d1!P1', bytesOf(10), null);
    expect(seen[0]?.headers).not.toHaveProperty('if-match');
  });

  it('saves a new file by name in a folder, refusing a name already taken (409)', async () => {
    const { onedrive, seen } = uploader(200);
    await onedrive.saveNew('d1!F1', 'تقرير: الربع/الأول', bytesOf(10), 'fail');
    expect(seen[0]?.url).toBe(`${GRAPH}/drives/d1/items/F1:/${encodeURIComponent('تقرير- الربع-الأول.pdf')}:/createUploadSession`);
    expect(JSON.parse(seen[0]?.body as string)).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'fail', name: 'تقرير- الربع-الأول.pdf' },
    });
    const top = uploader(200);
    await top.onedrive.saveNew(null, 'a.pdf', bytesOf(10), 'rename');
    expect(top.seen[0]?.url).toBe(`${GRAPH}/me/drive/root:/a.pdf:/createUploadSession`);
    const taken = uploader(409);
    await expect(taken.onedrive.saveNew(null, 'a.pdf', bytesOf(10), 'fail')).rejects.toMatchObject({ kind: 'nameTaken' });
  });

  it('removes an upload session that failed at its last range', async () => {
    const { onedrive, seen } = uploader(200, 409);
    await expect(onedrive.saveNew(null, 'a.pdf', bytesOf(10), 'fail')).rejects.toMatchObject({ kind: 'nameTaken' });
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: UPLOAD });
  });

  it('makes a name OneDrive accepts', () => {
    expect(oneDriveName('report')).toBe('report.pdf');
    expect(oneDriveName('a<b>c?.pdf')).toBe('a-b-c-.pdf');
    expect(oneDriveName('  ملف.PDF  ')).toBe('ملف.PDF');
    expect(oneDriveName('con')).toBe('_con.pdf');
    expect(oneDriveName('trailing. ')).toBe('trailing.pdf');
    expect(oneDriveName('')).toBe('document.pdf');
  });
});

describe('the desktop’s transport', () => {
  it('follows a redirect through the host, dropping the token when it leaves the host', async () => {
    const calls: [string, string | undefined][] = [];
    const transport = hostTransport(async (_provider, _method, url, headers) => {
      calls.push([url, headers.authorization]);
      return url.includes('graph') ? reply(302, '', { location: 'https://public.am.files.1drv.com/y4m' }) : reply(200, bytesOf(3));
    });
    const answer = await transport('onedrive', { method: 'GET', url: `${GRAPH}/me/drive/items/x/content`, headers: { authorization: 'Bearer t' } });
    expect(answer.status).toBe(200);
    expect(calls).toEqual([
      [`${GRAPH}/me/drive/items/x/content`, 'Bearer t'],
      ['https://public.am.files.1drv.com/y4m', undefined],
    ]);
  });

  it('says a host that could not be reached is the network, not the drive', async () => {
    const transport = hostTransport(async () => {
      throw new Error('E_NET: io: Connection refused');
    });
    await expect(transport('onedrive', { method: 'GET', url: GRAPH })).rejects.toMatchObject({ kind: 'network' });
  });
});
