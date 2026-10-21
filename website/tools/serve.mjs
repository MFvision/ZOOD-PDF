// A local preview server with the same headers as the Caddyfile, so the
// content security policy is tested too.  node website/tools/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.argv[2] ?? 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  if (path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, path);
  try {
    if ((await stat(file)).isDirectory()) throw new Error('dir');
    const body = await readFile(file);
    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}/`));
