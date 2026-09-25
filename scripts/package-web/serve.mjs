#!/usr/bin/env node
// ZOOD PDF (زود PDF) — tiny offline server for the web build.
// Dependency-free (node:http only). Serves ./app on 127.0.0.1 only, with the same strict
// CSP as the hosted PWA and the right MIME types (application/wasm for the engine/PDFium).
// Usage: node serve.mjs [--port 8787] [--open]
import { createServer } from 'node:http';
import { createReadStream, statSync, realpathSync } from 'node:fs';
import { extname, join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOST = '127.0.0.1';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.traineddata': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
};

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: http://localhost:11434 http://localhost:1234 https://api.anthropic.com",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

/** Maps a request URL path to a file inside root, or null when it would escape root. */
export function resolvePath(root, urlPath) {
  let path;
  try {
    path = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  const full = resolve(root, '.' + (path.startsWith('/') ? path : '/' + path));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

export function createHandler(root) {
  const realRoot = realpathSync(root);
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }
    let file = resolvePath(realRoot, req.url || '/');
    if (!file) {
      send(res, 400, 'Bad Request');
      return;
    }
    let st;
    try {
      st = statSync(file);
      if (st.isDirectory()) {
        file = join(file, 'index.html');
        st = statSync(file);
      }
      // Refuse symlinks that lead outside the app folder.
      const real = realpathSync(file);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('outside');
    } catch {
      // Single-page app: extension-less routes get the shell; missing assets are 404.
      if (extname(file) === '') {
        file = join(realRoot, 'index.html');
        try {
          st = statSync(file);
        } catch {
          send(res, 404, 'Not Found');
          return;
        }
      } else {
        send(res, 404, 'Not Found');
        return;
      }
    }
    const ext = extname(file).toLowerCase();
    const noCache = ext === '.html' || /(^|[\\/])(sw|service-worker)\.js$/.test(file) || ext === '.webmanifest';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

export function listen(root, port, attempts = 20) {
  return new Promise((resolveListen, reject) => {
    const server = createServer(createHandler(root));
    const tryPort = (p, left) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
        else reject(err);
      });
      server.listen(p, HOST, () => resolveListen(server));
    };
    tryPort(port, attempts);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--port');
  const port = Number(i >= 0 ? argv[i + 1] : process.env.PORT) || 8787;
  const root = resolve(HERE, 'app');
  const server = await listen(root, port);
  const url = `http://${HOST}:${server.address().port}/`;
  console.log(`ZOOD PDF | زود PDF → ${url}`);
  console.log('Close this window (or press Ctrl+C) to stop. | أغلق هذه النافذة لإيقاف الخادم.');
  if (argv.includes('--open')) openBrowser(url);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
