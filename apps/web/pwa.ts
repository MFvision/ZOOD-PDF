import { createHash } from 'node:crypto';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';

/**
 * The web app's service worker, written by the build: ZOOD PDF installed from
 * the browser opens and works without a network.
 *
 * It keeps the files of the app itself — the page, its scripts and styles,
 * both WebAssembly engines (Warraq's core and PDFium), the fonts, the stamps,
 * the icons — and nothing else. A document a person opens is read from
 * their disk and never goes through the network, so it never passes the
 * worker; requests to anywhere else (the AI tool's providers) are not
 * touched at all. OCR's language models and Tesseract are kept the first
 * time Scan & OCR fetches them, since not everyone needs 20 MB of them; the
 * line finder (its model, ONNX Runtime and its worker) too.
 *
 * The list is the build's own output, so a new build is a new worker: it
 * installs beside the old one, and replaces it (and its files) once no
 * window is using the old version.
 */

/** Kept when first used, not when the worker installs (Help & Support's PDF guides and their pictures too: each is fetched when it is shown). */
const ON_FIRST_USE = [/^ocr\//, /^assets\/[a-z-]+-(ar|en)-[^/]+\.(pdf|jpg|webp)$/, /^assets\/tesseract-core-/, /^assets\/worker\.min-/, /^assets\/ort-wasm-/, /^assets\/detect\.worker-/, /^licenses\//];
/** Never kept: the worker itself, and the welcome tour's film (8 MB, watched once, played by ranges). */
const NEVER = [/^sw\.js$/, /\.mp4$/];

function files(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, root) : [relative(root, path).split('\\').join('/')];
  });
}

/** The worker's source for a build whose files are `all` (paths relative to the site root). */
export function serviceWorkerSource(all: readonly string[]): string {
  const kept = all.filter((file) => !NEVER.some((pattern) => pattern.test(file)));
  const shell = kept.filter((file) => !ON_FIRST_USE.some((pattern) => pattern.test(file))).sort();
  const lazy = kept.filter((file) => ON_FIRST_USE.some((pattern) => pattern.test(file))).sort();
  const version = createHash('sha256').update(kept.sort().join('\n')).digest('hex').slice(0, 16);
  return `// ZOOD PDF's service worker, written by the build (apps/web/pwa.ts). It keeps the
// app's own files on the device, and never a document: files people open are
// read from their disk and never reach it.
const VERSION = ${JSON.stringify(version)};
const SHELL = ${JSON.stringify(shell.map((file) => `/${file}`))};
const LAZY = new Set(${JSON.stringify(lazy.map((file) => `/${file}`))});
const SHELL_CACHE = 'warraq-shell-' + VERSION;
const LAZY_CACHE = 'warraq-lazy-' + VERSION;
const IN_SHELL = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('warraq-') && key !== SHELL_CACHE && key !== LAZY_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function fromCache(request, name) {
  const cache = await caches.open(name);
  // A module script asks with an Origin header the install did not send;
  // a server that varies on it must not make the file look missing.
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function page(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('/index.html')) ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only the app's own files: anything else is none of the worker's business.
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(page(request));
    return;
  }
  if (IN_SHELL.has(url.pathname)) event.respondWith(fromCache(request, SHELL_CACHE));
  else if (LAZY.has(url.pathname)) event.respondWith(fromCache(request, LAZY_CACHE));
});
`;
}

/**
 * Writes `sw.js` beside the built site, listing what the build wrote. Only
 * for the web build: the desktop app loads its files from itself, and the
 * extension from the browser's own store.
 */
export function serviceWorker(): Plugin {
  let outDir = 'dist';
  let enabled = false;
  return {
    name: 'warraq:service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir.startsWith('/') ? config.build.outDir : join(config.root, config.build.outDir);
      enabled = config.mode !== 'tauri';
    },
    // After everything, public/ included, is on disk.
    closeBundle: {
      order: 'post',
      handler() {
        if (!enabled) return;
        writeFileSync(join(outDir, 'sw.js'), serviceWorkerSource(files(outDir)));
      },
    },
  };
}
