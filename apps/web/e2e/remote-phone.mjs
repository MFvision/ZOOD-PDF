// The phone remote's page, in a phone-sized Chromium, against the PC's own
// server. Not a Playwright spec: the desktop test that runs the server starts
// it (apps/desktop/src-tauri/src/remote/mod.rs, `the_phone_page_pairs_and_presents`)
// with the QR code's address as its one argument, and plays the PC's
// interface on the other end. Exits 0 when every step held.
import { chromium, expect } from '@playwright/test';

const url = process.argv[2];
if (!url) {
  console.error('usage: node remote-phone.mjs <the QR code address>');
  process.exit(2);
}

// CHROMIUM: a Chromium other than Playwright's own, if that is not downloaded.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' };
const step = (name) => console.log(`phone: ${name}`);
// SHOTS: a folder to keep pictures of the full-screen moments in.
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : undefined);

try {
  // VIDEO (with SHOTS): film the phone's screen too.
  const context = await browser.newContext(process.env.VIDEO && process.env.SHOTS ? { ...phone, recordVideo: { dir: process.env.SHOTS, size: phone.viewport } } : phone);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.goto(url);
  // The file the PC gave as the phone joined drops in full screen, to save or put away.
  const caught = page.getByRole('dialog', { name: 'From the computer' });
  await expect(caught.getByText('Notes from the PC.txt')).toBeVisible();
  await expect(caught.getByRole('link', { name: 'Save' })).toHaveAttribute('download', 'Notes from the PC.txt');
  await page.waitForTimeout(1000);
  await shot(page, 'catch');
  await caught.getByRole('button', { name: 'Done' }).tap();
  await expect(caught).toBeHidden();
  step('a file from the PC was caught full screen');
  await expect(page.getByText('Page 1 of 3')).toBeVisible();
  await expect(page.getByText('Talk.pdf')).toBeVisible();
  // The key leaves the address bar as soon as it is read.
  expect(new URL(page.url()).hash).toBe('');
  // The page's picture came from the PC.
  await expect(page.locator('.phone-stage img')).toHaveAttribute('src', /^data:image\/svg/);
  step('paired, the document and its first page are shown');

  await page.getByRole('button', { name: 'Next' }).tap();
  await expect(page.getByText('Page 2 of 3')).toBeVisible();
  await page.getByRole('button', { name: 'Start presenting' }).tap();
  await expect(page.getByRole('button', { name: 'Stop presenting' })).toBeVisible();
  await expect(page.getByText('Speaker note for page 2')).toBeVisible();
  step('next page, presenting, notes');

  const box = await page.locator('.phone-stage').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  step('laser');

  await page.getByRole('button', { name: 'Control', exact: true }).tap();
  await expect(page.getByText(/Trackpad and keyboard are off/)).toBeVisible();
  await page.getByRole('button', { name: 'Present', exact: true }).tap();
  step('PC control stays off until the PC allows it');

  // Send: what the PC copied is here, a file the PC sent is here, and a file
  // flicked up lands on the PC's desktop (the test's landing folder).
  await page.getByRole('button', { name: 'Send', exact: true }).tap();
  await expect(page.getByText('Hello from the PC')).toBeVisible();
  await page.getByRole('button', { name: 'Copy', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  await expect(page.getByText('Notes from the PC.txt')).toBeVisible();
  // A larger file from the PC came in parts, each answered, and is whole.
  await expect(page.getByText('Site plan from the PC.bin')).toBeVisible();
  await expect(page.locator('.phone-received li', { hasText: 'Site plan from the PC.bin' })).toContainText('1.2 MB');
  step('the PC\'s clipboard, and files from the PC (one in parts)');

  // The phone's clipboard to the PC: in a browser, a box to paste into.
  await page.getByRole('button', { name: 'Paste on the computer' }).tap();
  await page.locator('.phone-clip-field').fill('Copied on the phone');
  await page.getByRole('button', { name: 'Send to the computer' }).tap();
  await expect(page.getByText(/On the computer’s clipboard/)).toBeVisible();
  step('the phone\'s clipboard went to the PC');

  await page.locator('.phone-hero input[type=file]').setInputFiles({ name: 'Receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 flicked') });
  // Chosen, it waits on the dark full screen, to be swiped up into the light.
  const stage = page.getByRole('dialog', { name: 'Flick to the computer' });
  await expect(stage.getByText('Receipt.pdf')).toBeVisible();
  await expect(stage.getByText(/Swipe up to send it to/)).toBeVisible();
  await page.waitForTimeout(500);
  const at = await stage.locator('.phone-launch-card').boundingBox();
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2 - 120, { steps: 4 });
  await shot(page, 'launch');
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2 - 200, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  await shot(page, 'launched');
  await expect(stage).toBeHidden();
  const card = page.locator('.phone-flick').first();
  await expect(card).toContainText('On the desktop');
  step('a file flicked up landed on the desktop');

  // A large one goes in parts, with its progress, and lands whole.
  const big = Buffer.alloc(3 * 1024 * 1024 + 77, 7);
  await page.locator('.phone-hero input[type=file]').setInputFiles({ name: 'Site video.mp4', mimeType: 'video/mp4', buffer: big });
  const bigStage = page.getByRole('dialog', { name: 'Flick to the computer' });
  await expect(bigStage.getByText('Site video.mp4')).toBeVisible();
  await page.waitForTimeout(400);
  const bigAt = await bigStage.locator('.phone-launch-card').boundingBox();
  await page.mouse.move(bigAt.x + bigAt.width / 2, bigAt.y + bigAt.height / 2);
  await page.mouse.down();
  await page.mouse.move(bigAt.x + bigAt.width / 2, bigAt.y + bigAt.height / 2 - 260, { steps: 5 });
  await page.mouse.up();
  await expect(bigStage).toBeHidden();
  await expect(page.locator('.phone-flick').first()).toContainText('On the desktop', { timeout: 20_000 });
  step('a 3 MB file went in parts and landed');

  await page.getByRole('button', { name: 'Present', exact: true }).tap();

  // Closed and opened again: the phone is remembered, no code needed.
  await page.reload();
  await expect(page.getByText('Page 2 of 3')).toBeVisible();
  step('reopened without a code: remembered');

  // The code was for one phone; another one with it is turned away.
  const other = await (await browser.newContext(phone)).newPage();
  await other.goto(url);
  await expect(other.getByText(/This code was already used/)).toBeVisible();
  step('a second phone with the same code is refused');

  // A made-up key gets nowhere either.
  const stranger = await (await browser.newContext(phone)).newPage();
  await stranger.goto(url.replace(/#k=.*/, `#k=${'A'.repeat(43)}`));
  await expect(stranger.getByText(/This code was already used/)).toBeVisible();
  step('a wrong key is refused');

  if (errors.length) throw new Error(`errors on the page:\n${errors.join('\n')}`);
  console.log('phone: all steps held');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
