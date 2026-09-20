#!/usr/bin/env node
/**
 * How long the Library takes to read a folder, measured in a real browser.
 *
 * `packages/ui/src/library/ingest.ts` is driven exactly as the panel drives
 * it — the real WebAssembly core, the real Tesseract, the real reader worker
 * — over fifty corpus files: text PDFs, scans, encrypted files and pictures.
 * It prints what STATUS records: how long the run took, where the time went,
 * and what was skipped and why.
 *
 * The core's `library.add` is part A's, so the index itself is stubbed here:
 * what is measured is the reading, which is what this part does. Run it:
 *
 *     node scripts/measure-library.mjs [--port 4417] [--files 50]
 *
 * It starts Vite's dev server itself (the module has to be imported by path)
 * and stops it again. Nothing leaves the device.
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const UI = join(ROOT, 'packages', 'ui', 'src');

// Playwright belongs to the web app, not to the repository root.
const inWeb = createRequire(join(ROOT, 'apps', 'web', 'package.json'));
const { chromium } = inWeb('@playwright/test');

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const PORT = Number(argument('port', process.env.WARRAQ_E2E_PORT ?? 4417)) + 1;
const WANTED = Number(argument('files', 50));
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** A word of the corpus's Arabic truth, with no diacritics on it. */
const WORD = 'المستندات';

/** `--cleanup none|light|all` overrides what the Library cleans a scan up with. */
const CLEANUP = {
  none: { background: false, contrast: false, binarize: false, despeckle: false, borders: false },
  light: { background: true, contrast: true, binarize: false, despeckle: false, borders: false },
  all: { background: true, contrast: true, binarize: true, despeckle: true, borders: true },
}[argument('cleanup', '')];

/**
 * How much of the corpus's truth for the scanned page the Library read off
 * it: the same score `ocr.spec.ts` uses.
 */
const TRUTH_WORDS = [
  ...new Set(
    readFileSync(join(ROOT, 'tests', 'corpus', 'arabic', 'truth', 'scan-notonaskh-300dpi-skewed-jpeg.txt'), 'utf8')
      .split(/[\s|:،.()—؟]+/)
      .filter((word) => /[؀-ۿ]/.test(word) && word.length >= 3),
  ),
];

/** The files the run reads: text PDFs and scans from the corpus, then the pictures. */
function corpusFiles() {
  const picked = [];
  const take = (folder, names) => {
    for (const name of names) {
      const path = join(folder, name);
      const stat = statSync(path);
      picked.push({ path, name, size: stat.size, modified: Math.round(stat.mtimeMs) });
    }
  };
  const generated = join(ROOT, 'tests', 'corpus', 'arabic', 'generated');
  const realworld = join(ROOT, 'tests', 'corpus', 'arabic', 'realworld');
  const pdfs = (folder) => readdirSync(folder).filter((name) => name.endsWith('.pdf')).sort();
  // The pictures first, so they are measured even when the list is cut short.
  take(join(ROOT, 'tests', 'fixtures', 'create'), ['photo-arabic.jpg', 'scan-invoice.tiff']);
  take(generated, pdfs(generated));
  take(realworld, pdfs(realworld));
  return picked.slice(0, WANTED);
}

async function waitForServer(url, ms = 90_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const answer = await fetch(url);
      if (answer.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) throw new Error(`the dev server never answered on ${url}`);
    await new Promise((resolve_) => setTimeout(resolve_, 500));
  }
}

/**
 * Runs inside the page — it is sent there as its own source, so it may use
 * nothing from this file: the real ingest over the files, the index stubbed.
 */
async function ingestInPage({ where, files, word, truth, cleanup }) {
  const [{ ingestFiles }, { CoreClient }] = await Promise.all([
    import(`${where}/library/ingest.ts`),
    import(`${where}/core/client.ts`),
  ]);
  const client = new CoreClient();
  await client.init();
  const indexed = [];
  const stub = {
    open: (bytes, password) => client.open(bytes, password),
    callStatic: (op, args, blobs) => {
      if (op !== 'library.add') return client.callStatic(op, args, blobs);
      const chars = (args.text ?? []).reduce((sum, page) => sum + page.text.length, 0);
      const text = (args.text ?? []).map((page) => page.text).join('\n');
      const share = truth.filter((each) => text.includes(each)).length / truth.length;
      indexed.push({ name: args.name, kind: args.kind, chars, found: text.includes(word), share, missed: truth.filter((each) => !text.includes(each)) });
      return Promise.resolve({ result: { added: true, pages: args.pages ?? 0, chars }, blobs: [] });
    },
  };
  const stages = { reading: 0, recognizing: 0, indexing: 0 };
  let last = performance.now();
  let stage = null;
  const run = await ingestFiles({
    handle: 1,
    files: files.map((file) => ({
      key: file.path,
      name: file.name,
      size: file.size,
      modified: file.modified,
      read: () => fetch(file.url).then((answer) => answer.arrayBuffer()),
    })),
    client: stub,
    languages: ['ara', 'eng'],
    ...(cleanup ? { cleanup } : {}),
    onProgress: (progress) => {
      const now = performance.now();
      if (stage) stages[stage] += now - last;
      [stage, last] = [progress.stage, now];
    },
  });
  if (stage) stages[stage] += performance.now() - last;
  // The thumbnails are bytes: their size is what travels back, not the picture.
  const files_ = run.files.map((file) => ({ ...file, thumbnail: file.thumbnail ? file.thumbnail.image.byteLength : 0 }));
  return { run: { ...run, files: files_ }, indexed, stages };
}

const ms = (value) => `${Math.round(value)} ms`;

async function main() {
  const files = corpusFiles();
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: join(ROOT, 'apps', 'web'),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    await waitForServer(ORIGIN);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(900_000);
    page.on('console', (message) => {
      if (message.type() === 'error') process.stderr.write(`page error: ${message.text()}\n`);
    });
    // The files are served from the app's own origin, as a host would hand them over.
    await page.route(`${ORIGIN}/measure/**`, (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.replace('/measure/', ''));
      const file = files.find((entry) => entry.path === name);
      if (!file) return route.fulfill({ status: 404, body: 'no such file' });
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(file.path) });
    });
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    const handed = files.map((file) => ({ ...file, url: `${ORIGIN}/measure/${encodeURIComponent(file.path)}` }));
    const started = Date.now();
    const { run, indexed, stages } = await page.evaluate(ingestInPage, { where: `/@fs${UI}`, files: handed, word: WORD, truth: TRUTH_WORDS, cleanup: CLEANUP });
    const wall = Date.now() - started;

    const kinds = {};
    for (const file of run.files) kinds[file.kind ?? 'unknown'] = (kinds[file.kind ?? 'unknown'] ?? 0) + 1;
    const reasons = {};
    for (const file of run.files) if (file.skipped) reasons[file.skipped] = (reasons[file.skipped] ?? 0) + 1;
    const slowest = [...run.files].sort((a, b) => b.took - a.took).slice(0, 5);
    const bytes = files.reduce((sum, file) => sum + file.size, 0);

    console.log(`\nThe Library read ${files.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) in ${ms(wall)}`);
    console.log(`  indexed ${run.added}, skipped ${run.skipped} (${run.failed} unreadable), ${run.recognized} pages recognized`);
    console.log(`  kinds: ${JSON.stringify(kinds)}`);
    console.log(`  skipped because: ${JSON.stringify(reasons)}`);
    console.log(`  reading ${ms(stages.reading)}, recognizing ${ms(stages.recognizing)}, indexing ${ms(stages.indexing)}`);
    console.log(`  per file: ${ms(wall / files.length)}; thumbnails ${run.files.filter((file) => file.thumbnail > 0).length}, ${Math.round(run.files.reduce((sum, file) => sum + file.thumbnail, 0) / 1024)} kB in all`);
    console.log('  slowest:');
    for (const file of slowest) console.log(`    ${ms(file.took).padStart(9)}  ${file.name} (${file.kind ?? '—'}${file.skipped ? `, ${file.skipped}` : ''})`);
    const found = indexed.filter((entry) => entry.found);
    console.log(`\n"${WORD}" is in ${found.length} of the ${indexed.length} documents indexed:`);
    for (const entry of found.slice(0, 8)) console.log(`    ${entry.kind.padEnd(11)} ${entry.name}`);
    const photo = indexed.find((entry) => entry.name === 'photo-arabic.jpg');
    const scan = indexed.find((entry) => entry.name === 'scan-notonaskh-300dpi-skewed-jpeg.pdf');
    const scored = (entry) => `${entry.chars} characters, ${Math.round(entry.share * 100)} % of the truth's words, "${WORD}" ${entry.found ? 'found' : 'NOT found'}`;
    console.log(`\nthe scanned Arabic page:          ${scan ? scored(scan) : 'not in this run'}`);
    console.log(`the photograph of an Arabic page: ${photo ? scored(photo) : 'not in this run'}`);
    if (photo) console.log(`  words it missed: ${photo.missed.join(' ')}`);
    if (scan) console.log(`  words the scan missed: ${scan.missed.join(' ')}`);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}

await main();
