import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { build, preview } from 'vite';
import type { PreviewServer } from 'vite';
import { INVOICE, WORD_EXPORT, activeMode, annotationTypes, answer, chooseTool, embedTiles, openPdf, pageBox, test, useAction } from './helpers';
import { FakeMicrosoft, GRAPH, MS_CLIENT_ID, MS_DOWNLOADS, MS_UPLOADS } from './cloudFakes';
import type { FakeRequest, FakeResponse } from './cloudFakes';

/**
 * OneDrive, through the interface, against a stand-in for Microsoft's
 * identity platform and Graph (`cloudFakes.ts`) that checks what they check:
 * PKCE, the SPA redirect URI and its origin, no secret, bearer tokens,
 * If-Match and upload ranges.
 *
 * The default build offers no drive, so this spec builds its own, configured
 * with a client ID used here only (never shipped), and serves it beside the
 * default one. The first test shows the default build has no cloud control.
 */

const WEB = fileURLToPath(new URL('..', import.meta.url));
const CLOUD_BUILD = fileURLToPath(new URL('../node_modules/.e2e-cloud/', import.meta.url));
const CLOUD_PORT = Number(process.env.WARRAQ_E2E_PORT ?? 4391) + 100;
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;

let server: PreviewServer | null = null;

test.beforeAll(async () => {
  const kept = process.env.WARRAQ_ONEDRIVE_CLIENT_ID;
  process.env.WARRAQ_ONEDRIVE_CLIENT_ID = MS_CLIENT_ID;
  try {
    await build({ root: WEB, configFile: `${WEB}vite.config.ts`, logLevel: 'error', build: { outDir: CLOUD_BUILD, emptyOutDir: true } });
  } finally {
    if (kept === undefined) delete process.env.WARRAQ_ONEDRIVE_CLIENT_ID;
    else process.env.WARRAQ_ONEDRIVE_CLIENT_ID = kept;
  }
  server = await preview({
    root: WEB,
    configFile: `${WEB}vite.config.ts`,
    logLevel: 'error',
    build: { outDir: CLOUD_BUILD },
    preview: { host: '127.0.0.1', port: CLOUD_PORT, strictPort: true },
  });
});

test.afterAll(async () => {
  await server?.close();
});

/* ---------------------------------------------------------------- helpers */

async function toFake(request: Request): Promise<FakeRequest> {
  return { method: request.method(), url: request.url(), headers: await request.allHeaders(), body: request.postDataBuffer() };
}

const reply = (response: FakeResponse) => ({ status: response.status, headers: response.headers, body: response.body });

/** Microsoft's servers, as the page (and its sign-in window) reach them. */
async function microsoft(page: Page, fake: FakeMicrosoft): Promise<void> {
  await answer(page, 'https://login.microsoftonline.com/', async (request) => reply(fake.token(await toFake(request))));
  await answer(page, 'https://graph.microsoft.com/', async (request) => reply(fake.graph(await toFake(request))));
  await answer(page, MS_DOWNLOADS, async (request) => reply(fake.download(await toFake(request))));
  await answer(page, MS_UPLOADS, async (request) => reply(fake.upload(await toFake(request))));
  // The sign-in window is a page of its own: the person signs in and consents there.
  await page.context().route(
    (url) => url.origin === 'https://login.microsoftonline.com' && url.pathname.endsWith('/authorize'),
    async (route) => {
      const out = fake.authorize(route.request().url(), [`${CLOUD}/oauth-callback.html`, 'http://127.0.0.1/callback']);
      if ('redirect' in out) await route.fulfill({ status: 302, headers: { location: out.redirect } });
      else await route.fulfill({ status: out.status, contentType: 'text/html', body: out.body });
    },
  );
}

/** A drive with a folder of invoices (more than one page of it) and a report at the top. */
function driveWithFiles(): { fake: FakeMicrosoft; invoices: string; invoice: string; report: string } {
  const fake = new FakeMicrosoft(CLOUD);
  const invoices = fake.addFolder('الفواتير');
  fake.addFolder('Archive');
  const report = fake.addFile('World Bank briefing.pdf', readFileSync(WORD_EXPORT));
  fake.addFile('notes.docx', Buffer.from('not a pdf'));
  const invoice = fake.addFile('فاتورة ٢٠٢٦.pdf', readFileSync(INVOICE), invoices);
  for (const n of [1, 2, 3, 4]) fake.addFile(`older ${n}.pdf`, readFileSync(INVOICE), invoices);
  return { fake, invoices, invoice, report };
}

const sheet = (page: Page) => page.getByRole('dialog');
const cloudSection = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Cloud drives' }) });
const oneDriveRow = (page: Page) => cloudSection(page).locator('.cloud-drive', { hasText: 'OneDrive' });

async function fileMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Signs in from the sheet on screen: the pop-up opens, the person consents, it closes. */
async function signIn(page: Page, stay = false): Promise<void> {
  const dialog = sheet(page);
  await expect(dialog.getByRole('heading', { name: 'Sign in to OneDrive' })).toBeVisible();
  if (stay) await dialog.getByRole('checkbox', { name: 'Stay signed in on this browser' }).check();
  const [popup] = await Promise.all([page.waitForEvent('popup'), dialog.getByRole('button', { name: 'Sign In', exact: true }).click()]);
  await popup.waitForEvent('close');
}

/** Opens `name` in folder `folder` from the Open sheet. */
async function openFromSheet(page: Page, name: string, folder?: string): Promise<void> {
  const dialog = sheet(page);
  if (folder) await dialog.getByRole('button', { name: new RegExp(`^${folder}`) }).click();
  await dialog.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
}

async function draw(page: Page, at = 0.2): Promise<void> {
  // The drawing tool may still be in hand from an earlier one: choosing it
  // again would put it down.
  if ((await activeMode(page)) === 'pointerMode') {
    await chooseTool(page, 'Comment');
    await useAction(page, 'Draw');
  }
  const box = await pageBox(page);
  await page.mouse.move(box.x + box.width * at, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (at + 0.3), box.y + box.height * 0.7, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => annotationTypes(page)).toContain(15);
}

async function save(page: Page): Promise<void> {
  await page.getByRole('toolbar').getByRole('button', { name: 'Save' }).click();
}

const startsWith = (bytes: Buffer, own: Buffer) => bytes.subarray(0, own.length).equals(own);

/* ------------------------------------------------------------------ tests */

test('a build with no drive configured shows no cloud control and allows no drive’s host', async ({ page, stayLocal: _ }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cloud drives' })).toHaveCount(0);
  await expect(page.getByText('OneDrive')).toHaveCount(0);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'File' }).getByRole('menuitem')).toHaveText([/^Open…/, /^Save/, /^Versions…/, /^Print…/, /^Close document/]);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).not.toMatch(/microsoft|1drv|sharepoint|googleapis/);
});

test.describe('OneDrive in the browser', () => {
  test.use({ baseURL: CLOUD });

  test('nothing reaches Microsoft until a click; signing in, browsing a folder page by page, searching and opening a PDF', async ({
    page,
    stayLocal: _,
  }) => {
    const { fake } = driveWithFiles();
    fake.pageSize = 3;
    await microsoft(page, fake);
    await page.goto('/');
    await expect(oneDriveRow(page)).toContainText('Not signed in');
    await expect(page.getByText('Files leave this device only when you save them to a cloud drive yourself.')).toBeVisible();
    await page.waitForTimeout(500);
    expect(fake.log).toHaveLength(0);
    expect(fake.tokenRequests).toHaveLength(0);

    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    await signIn(page);
    // The code was redeemed with the verifier, from the app's own origin, with no secret.
    // The page redeems it after the popup has closed, so this waits for it.
    await expect.poll(() => fake.tokenRequests.length).toBe(1);
    expect(fake.tokenRequests[0]).toMatchObject({ grant_type: 'authorization_code', client_id: MS_CLIENT_ID, redirect_uri: `${CLOUD}/oauth-callback.html` });
    expect(fake.tokenRequests[0]).not.toHaveProperty('client_secret');

    const dialog = sheet(page);
    await expect(dialog.getByRole('heading', { name: 'Open from OneDrive' })).toBeVisible();
    await expect(dialog).toContainText('Signed in as');
    await expect(dialog).toContainText('sara@example.com');
    // Folders first, then PDFs; the Word file is not a PDF and is not listed.
    await expect(dialog.getByRole('list', { name: 'Files' }).getByRole('button')).toHaveText([/^Archive/, /^الفواتير/, /^World Bank briefing\.pdf/]);

    await dialog.getByRole('button', { name: /^الفواتير/ }).click();
    const list = dialog.getByRole('list', { name: 'Files' }).getByRole('button');
    await expect(list).toHaveCount(3);
    await dialog.getByRole('button', { name: 'Show More' }).click();
    await expect(list).toHaveCount(5);
    await expect(dialog.getByRole('navigation', { name: 'Folders' })).toContainText('الفواتير');

    await dialog.getByRole('searchbox', { name: 'Search OneDrive' }).fill('فاتورة');
    await dialog.getByRole('searchbox', { name: 'Search OneDrive' }).press('Enter');
    await expect(dialog).toContainText('Results for');
    await expect(list).toHaveCount(1);
    await expect(list.first()).toContainText(/In .?الفواتير/);
    await list.first().click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    await expect(page.getByRole('toolbar')).toContainText('فاتورة ٢٠٢٦');
    // The download went to the pre-authenticated address, without the token.
    const download = fake.log.find((r) => r.url.startsWith(MS_DOWNLOADS));
    expect(download?.headers.authorization).toBeUndefined();

    // Home again: the file is listed with its drive, and reopens from it without a sign-in.
    await fileMenu(page, 'Close document');
    const tile = cloudSection(page).getByRole('button', { name: /فاتورة ٢٠٢٦/ });
    await expect(tile).toBeVisible();
    await expect(page.locator('section', { has: page.getByRole('heading', { name: 'Recent' }) })).not.toContainText('فاتورة ٢٠٢٦');
    const downloads = fake.log.filter((r) => r.url.startsWith(MS_DOWNLOADS)).length;
    await tile.click();
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    expect(fake.log.filter((r) => r.url.startsWith(MS_DOWNLOADS))).toHaveLength(downloads + 1);
    expect(fake.tokenRequests).toHaveLength(1);
  });

  test('in Folders, a drive opens in place to what is in it: sign in first, then folders and PDFs as pages, a click opens one', async ({
    page,
    stayLocal: _,
  }) => {
    const { fake } = driveWithFiles();
    await microsoft(page, fake);
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Home sections' }).getByRole('button', { name: 'Folders', exact: true }).click();
    await page.getByRole('button', { name: 'Open the folder OneDrive' }).click();
    const drive = page.locator('section', { has: page.getByRole('heading', { name: /OneDrive/ }) });
    // Nothing reaches Microsoft until the person signs in.
    expect(fake.log).toHaveLength(0);
    await drive.getByRole('button', { name: /^Sign In/ }).click();
    await signIn(page);
    const cards = drive.getByRole('list').getByRole('button');
    await expect(cards).toHaveText([/^Choose Files/, /^Archive/, /^الفواتير/, /^World Bank briefing/]);
    // Choosing more is its own card: from the drive, or from this computer.
    await cards.first().click();
    await expect(page.getByRole('menu', { name: 'Choose Files' }).getByRole('menuitem')).toHaveText(['From OneDrive…', 'From This Computer…']);
    await page.keyboard.press('Escape');
    await drive.getByRole('button', { name: /^الفواتير/ }).click();
    await expect(drive.getByRole('heading')).toContainText('الفواتير');
    await drive.getByRole('button', { name: /^فاتورة ٢٠٢٦/ }).click();
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    await expect(page.getByRole('toolbar')).toContainText('فاتورة ٢٠٢٦');
  });

  test('several PDFs ticked in a folder open together, each in a tab of its own', async ({ page, stayLocal: _ }) => {
    const { fake } = driveWithFiles();
    await microsoft(page, fake);
    await page.goto('/');
    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    await signIn(page);
    const dialog = sheet(page);
    await dialog.getByRole('button', { name: /^الفواتير/ }).click();
    await expect(dialog.getByRole('list', { name: 'Files' }).getByRole('button')).toHaveCount(5);
    await expect(dialog.getByRole('button', { name: /^Open Chosen/ })).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: /فاتورة ٢٠٢٦\.pdf/ }).check();
    await dialog.getByRole('checkbox', { name: /older 1\.pdf/ }).check();
    await dialog.getByRole('button', { name: 'Open Chosen (2)' }).click();
    await expect(dialog).toBeHidden();
    const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toContainText('فاتورة ٢٠٢٦');
    await expect(tabs.nth(1)).toContainText('older 1');
  });

  test('Save writes a new revision checked against the eTag it was opened at; a version conflict is the person’s to settle', async ({
    page,
    stayLocal: _,
  }) => {
    const { fake, invoice } = driveWithFiles();
    await microsoft(page, fake);
    const original = readFileSync(INVOICE);
    await page.goto('/');
    await fileMenu(page, 'Open from OneDrive…');
    await signIn(page);
    await openFromSheet(page, 'فاتورة ٢٠٢٦', 'الفواتير');
    const opened = fake.eTag(fake.items.get(invoice)!);

    let downloaded = false;
    page.on('download', () => {
      downloaded = true;
    });
    await draw(page);
    await save(page);
    const saved = fake.items.get(invoice)!;
    await expect.poll(() => saved.version).toBe(2);
    await expect(page.getByRole('status').filter({ hasText: 'Saved to OneDrive.' })).toBeVisible();
    const session = fake.log.find((r) => r.url.endsWith('/createUploadSession'));
    expect(session?.headers['if-match']).toBe(opened);
    expect(startsWith(saved.bytes, original), 'the file’s own bytes first: an incremental update').toBe(true);
    expect(saved.bytes.includes('/Ink')).toBe(true);
    expect(downloaded, 'nothing was downloaded instead').toBe(false);
    await expect(page.getByRole('toolbar').getByRole('status', { name: 'Document status' })).not.toContainText('Edited');

    // Someone else saves it in OneDrive; saving again here is a conflict, not an overwrite.
    fake.touch(invoice);
    const theirs = Buffer.from(fake.items.get(invoice)!.bytes);
    await draw(page, 0.5);
    await save(page);
    const dialog = sheet(page);
    await expect(dialog.getByRole('heading', { name: 'This file changed in OneDrive' })).toBeVisible();
    await expect(dialog).toContainText("stays in the file's version history in OneDrive");
    expect(fake.items.get(invoice)!.bytes.equals(theirs), 'their version is still there').toBe(true);

    // A copy beside it, under a name of its own: theirs stays as it is.
    await dialog.getByRole('button', { name: 'Save as a Copy…' }).click();
    await expect(dialog.getByRole('heading', { name: 'Save to OneDrive' })).toBeVisible();
    await expect(dialog.getByRole('navigation', { name: 'Folders' })).toContainText('الفواتير');
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('فاتورة ٢٠٢٦ (copy).pdf');
    await dialog.getByRole('button', { name: 'Save Here' }).click();
    await expect(dialog).toBeHidden();
    const copy = [...fake.items.values()].find((item) => item.name === 'فاتورة ٢٠٢٦ (copy).pdf');
    expect(copy?.parent).toBe(fake.items.get(invoice)!.parent);
    expect(fake.items.get(invoice)!.bytes.equals(theirs)).toBe(true);
    await expect(page.getByRole('toolbar')).toContainText('فاتورة ٢٠٢٦ (copy)');

    // The document is now the copy: its next save is a revision of it.
    await draw(page, 0.1);
    await save(page);
    await expect.poll(() => copy?.version).toBe(2);
  });

  test('replacing their version after a conflict sends no If-Match and keeps nothing of theirs', async ({ page, stayLocal: _ }) => {
    const { fake, report } = driveWithFiles();
    await microsoft(page, fake);
    await page.goto('/');
    await fileMenu(page, 'Open from OneDrive…');
    await signIn(page);
    await openFromSheet(page, 'World Bank briefing');
    fake.touch(report);
    await draw(page);
    await save(page);
    await sheet(page).getByRole('button', { name: 'Replace', exact: true }).click();
    const item = fake.items.get(report)!;
    await expect.poll(() => item.version).toBe(3);
    await expect(page.getByRole('status').filter({ hasText: 'Saved to OneDrive.' })).toBeVisible();
    const sessions = fake.log.filter((r) => r.url.endsWith('/createUploadSession'));
    expect(sessions.map((r) => r.headers['if-match'] !== undefined)).toEqual([true, false]);
    const saved = fake.items.get(report)!;
    expect(startsWith(saved.bytes, readFileSync(WORD_EXPORT))).toBe(true);
    expect(saved.bytes.includes('edited elsewhere')).toBe(false);
  });

  test('Save to OneDrive puts a file from this device in a folder, asks before taking a name, and saves there afterwards', async ({
    page,
    stayLocal: _,
  }) => {
    const { fake, invoices } = driveWithFiles();
    await microsoft(page, fake);
    await page.goto('/');
    await openPdf(page, INVOICE);
    await fileMenu(page, 'Save to OneDrive…');
    await signIn(page);
    const dialog = sheet(page);
    await expect(dialog.getByRole('heading', { name: 'Save to OneDrive' })).toBeVisible();
    await dialog.getByRole('button', { name: /^الفواتير/ }).click();
    // PDFs are shown for where they are, not to be chosen.
    await expect(dialog.getByRole('button', { name: /^older 1/ })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Name' }).fill('older 1');
    await expect(dialog).toContainText(/It will be saved as “.?older 1\.pdf.?”\./);
    await dialog.getByRole('button', { name: 'Save Here' }).click();
    // The name is taken: nothing was written over it.
    await expect(dialog.getByRole('heading', { name: /already exists/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep Both' }).click();
    await expect(dialog).toBeHidden();
    const kept = fake.childrenOf(invoices).find((item) => item.name === 'older 1 1.pdf');
    expect(kept?.bytes.equals(readFileSync(INVOICE))).toBe(true);
    await expect(page.getByRole('toolbar')).toContainText('older 1 1');

    // From now on Save goes there, as a checked revision.
    await draw(page);
    await save(page);
    await expect.poll(() => kept?.version).toBe(2);
    expect(fake.log.filter((r) => r.url.endsWith('/createUploadSession')).at(-1)?.headers['if-match']).toBe(`"{${kept?.id}},1"`);
    await expect(page.getByRole('status').filter({ hasText: 'Saved to OneDrive.' })).toBeVisible();

    // And a copy can still be kept on this device.
    const [download] = await Promise.all([page.waitForEvent('download'), fileMenu(page, 'Save a Copy on This Device…')]);
    expect(download.suggestedFilename()).toBe('older 1 1.pdf');
  });

  test('staying signed in survives a reload (the kept token is refreshed, and rotated); without it a reload forgets; signing out forgets all of it', async ({
    page,
    stayLocal: _,
  }) => {
    const { fake } = driveWithFiles();
    await microsoft(page, fake);
    await page.goto('/');
    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    await signIn(page);
    await expect(sheet(page).getByRole('heading', { name: 'Open from OneDrive' })).toBeVisible();
    await page.reload();
    await expect(oneDriveRow(page)).toContainText('Not signed in');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('warraq.cloud.session')))).toEqual([]);

    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    await signIn(page, true);
    await openFromSheet(page, 'World Bank briefing');
    const kept = await page.evaluate(() => localStorage.getItem('warraq.cloud.session.onedrive'));
    expect(kept).toContain('refreshToken');

    await page.reload();
    await expect(oneDriveRow(page)).toContainText('sara@example.com');
    fake.expireAccessTokens();
    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    // Straight to the files: the kept refresh token, not a sign-in window.
    await expect(sheet(page).getByRole('heading', { name: 'Open from OneDrive' })).toBeVisible();
    await expect(sheet(page).getByRole('list', { name: 'Files' }).getByRole('button').first()).toBeVisible();
    const refreshes = fake.tokenRequests.filter((form) => form.grant_type === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.refresh_token).toBe(JSON.parse(kept ?? '{}').refreshToken);
    const rotated = JSON.parse((await page.evaluate(() => localStorage.getItem('warraq.cloud.session.onedrive'))) ?? '{}') as { refreshToken?: string };
    expect(rotated.refreshToken).not.toBe(JSON.parse(kept ?? '{}').refreshToken);
    await sheet(page).getByRole('button', { name: 'Cancel' }).click();

    await expect(cloudSection(page).getByRole('button', { name: /World Bank briefing/ })).toBeVisible();
    await oneDriveRow(page).getByRole('button', { name: 'Sign out of OneDrive' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Signed out of OneDrive on this device.' })).toBeVisible();
    await expect(oneDriveRow(page)).toContainText('Not signed in');
    await expect(cloudSection(page).getByRole('button', { name: /World Bank briefing/ })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('warraq.cloud.') && key !== 'warraq.cloud.recentThumbs').sort())).toEqual([
      'warraq.cloud.accounts',
      'warraq.cloud.recent',
    ]);
    expect(await page.evaluate(() => [localStorage.getItem('warraq.cloud.accounts'), localStorage.getItem('warraq.cloud.recent')])).toEqual(['{}', '[]']);
    const before = fake.log.length + fake.tokenRequests.length;
    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    await expect(sheet(page).getByRole('heading', { name: 'Sign in to OneDrive' })).toBeVisible();
    expect(fake.log.length + fake.tokenRequests.length).toBe(before);
  });

  test('a declined consent is said to be cancelled, and an access token Graph refuses is refreshed once without asking', async ({
    page,
    stayLocal: _,
  }) => {
    const { fake } = driveWithFiles();
    await microsoft(page, fake);
    await page.goto('/');
    fake.consent = 'deny';
    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    await signIn(page);
    await expect(sheet(page).getByRole('alert')).toHaveText('The sign-in was cancelled.');
    expect(fake.tokenRequests).toHaveLength(0);

    fake.consent = 'grant';
    await signIn(page);
    await expect(sheet(page).getByRole('list', { name: 'Files' }).getByRole('button').first()).toBeVisible();
    fake.expireAccessTokens();
    await sheet(page).getByRole('button', { name: /^Archive/ }).click();
    await expect(sheet(page)).toContainText('No folders or PDF files here.');
    const refused = fake.log.filter((r) => r.url.startsWith(GRAPH) && r.url.includes('/children'));
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(fake.tokenRequests.map((form) => form.grant_type)).toEqual(['authorization_code', 'refresh_token']);
  });
});

/* --------------------------------------------- the pictures for the design notes */

/**
 * The cloud screens for `docs/design/screenshots/`, taken from the build this
 * spec makes. Not a test of behaviour — every state shown is proven above — so
 * it runs only when asked for:
 *
 *   WARRAQ_SCREENSHOTS=1 pnpm --filter @warraq/web exec playwright test e2e/cloud.spec.ts
 */
const SHOTS = fileURLToPath(new URL('../../../docs/design/screenshots/', import.meta.url));

test.describe('the cloud screens, for the design notes', () => {
  test.use({ baseURL: CLOUD });
  test.skip(!process.env.WARRAQ_SCREENSHOTS, 'screenshots are taken on request only');
  test.describe.configure({ mode: 'serial' });

  async function shoot(page: Page, name: string): Promise<void> {
    mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}${name}.png` });
  }

  /** The app in a language and a theme, with a drive behind it. */
  async function ready(page: Page, lang: 'en' | 'ar', theme: 'light' | 'dark', size = { width: 1440, height: 900 }): Promise<FakeMicrosoft> {
    const { fake } = driveWithFiles();
    await microsoft(page, fake);
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(
      ([chosen]) => {
        if (localStorage.getItem('warraq.preferences')) return;
        localStorage.setItem('warraq.preferences', JSON.stringify({ lang: chosen, theme: 'system' }));
        localStorage.setItem('warraq.recent', JSON.stringify(['التقرير السنوي ٢٠٢٥.pdf', 'Quarterly review.pdf']));
      },
      [lang],
    );
    await page.goto('/');
    await expect(page.locator('.shell')).toBeVisible();
    return fake;
  }

  /** Signs in from whichever sheet is on screen, in either language. */
  async function signInHere(page: Page): Promise<void> {
    const [popup] = await Promise.all([page.waitForEvent('popup'), sheet(page).locator('.icon-btn-primary').click()]);
    await popup.waitForEvent('close');
    await expect(sheet(page).locator('.cloud-list button').first()).toBeVisible();
  }

  test('the drives on the home screen, signing in, and browsing (English, light)', async ({ page, stayLocal: _ }) => {
    await ready(page, 'en', 'light');
    await shoot(page, 'cloud-home-en-light');
    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    await expect(sheet(page)).toBeVisible();
    await shoot(page, 'cloud-signin-en-light');
    await signInHere(page);
    await shoot(page, 'cloud-browse-en-light');
    await sheet(page).getByRole('button', { name: 'Cancel' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Cloud drives' })).toBeVisible();
    await shoot(page, 'cloud-phone-home-en-light');
  });

  test('the same in Arabic, dark', async ({ page, stayLocal: _ }) => {
    await ready(page, 'ar', 'dark');
    await shoot(page, 'cloud-home-ar-dark');
    // The section's heading is Arabic here: the drive's own row is the anchor.
    await page.locator('.cloud-drive', { hasText: 'OneDrive' }).locator('.icon-btn-labeled').click();
    await expect(sheet(page)).toBeVisible();
    await signInHere(page);
    await shoot(page, 'cloud-browse-ar-dark');
  });

  test('a file that changed in the drive', async ({ page, stayLocal: _ }) => {
    const fake = await ready(page, 'en', 'light');
    await oneDriveRow(page).getByRole('button', { name: 'Open from OneDrive…' }).click();
    await signInHere(page);
    await openFromSheet(page, 'World Bank briefing');
    await draw(page);
    const report = [...fake.items.values()].find((item) => item.name === 'World Bank briefing.pdf');
    if (report) fake.touch(report.id);
    await save(page);
    await expect(sheet(page).getByRole('heading', { name: 'This file changed in OneDrive' })).toBeVisible();
    await shoot(page, 'cloud-conflict-en-light');
    await sheet(page).getByRole('button', { name: 'Cancel' }).click();
  });
});
