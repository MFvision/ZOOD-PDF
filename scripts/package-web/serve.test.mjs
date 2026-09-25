// node --test scripts/package-web/serve.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { listen, resolvePath, HOST } from './serve.mjs';

let dir;
let server;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zood-serve-'));
  const app = join(dir, 'app');
  mkdirSync(join(app, 'assets'), { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>ZOOD PDF</title>');
  writeFileSync(join(app, 'assets', 'engine.wasm'), Buffer.from([0, 97, 115, 109]));
  writeFileSync(join(app, 'assets', 'app.js'), 'export {}');
  writeFileSync(join(app, 'assets', 'ملف.json'), '{}');
  writeFileSync(join(dir, 'secret.txt'), 'secret');
  try {
    symlinkSync(join(dir, 'secret.txt'), join(app, 'link.txt'));
  } catch {
    /* symlinks may be unavailable (Windows without privilege) */
  }
  server = await listen(app, 0, 0);
  base = `http://${HOST}:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

function get(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('binds to 127.0.0.1 only', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('serves wasm as application/wasm with CSP and nosniff', async () => {
  const r = await get('/assets/engine.wasm');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/wasm');
  assert.match(r.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('javascript, html and percent-encoded Arabic names', async () => {
  assert.equal((await get('/assets/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.equal(root.headers['cache-control'], 'no-cache');
  assert.equal((await get(`/assets/${encodeURIComponent('ملف.json')}`)).status, 200);
});

test('SPA routes fall back to index.html, missing assets are 404', async () => {
  const r = await get('/library/recent');
  assert.equal(r.status, 200);
  assert.match(r.body, /ZOOD PDF/);
  assert.equal((await get('/assets/missing.js')).status, 404);
});

test('refuses traversal, NUL bytes, bad encodings and symlinks out of the folder', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/a%00b', '/%E0%A4%A']) {
    const r = await get(p);
    assert.ok(r.status === 400 || r.status === 404, `${p} → ${r.status}`);
    assert.doesNotMatch(r.body, /secret/);
  }
  const link = await get('/link.txt');
  assert.notEqual(link.body, 'secret');
});

test('only GET and HEAD', async () => {
  assert.equal((await get('/', 'POST')).status, 405);
  const head = await get('/assets/engine.wasm', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('resolvePath stays inside root', () => {
  assert.equal(resolvePath('/srv/app', '/../../etc/passwd'), null);
  assert.equal(resolvePath('/srv/app', '/a/../b.js'), '/srv/app/b.js');
  assert.equal(resolvePath('/srv/app', '/x%00'), null);
});
