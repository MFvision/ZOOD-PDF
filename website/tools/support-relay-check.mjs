// Checks the support relay (website/api/support) end to end, with PHP's own
// server, SQLite in place of MySQL, and a fake GitHub that records what it
// is sent. Needs `php` with pdo_sqlite and curl:
//   node website/tools/support-relay-check.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const relayDir = join(here, '..', 'api', 'support');
const work = mkdtempSync(join(tmpdir(), 'zood-relay-'));

// The fake GitHub: issues in memory, labels set by the test.
const issues = new Map();
const files = [];
let next = 1;
const github = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    assert.equal(req.headers.authorization, 'Bearer test-token');
    let m;
    if (req.method === 'POST' && url.pathname === '/repos/o/r/issues') {
      const issue = { number: next++, title: body.title, body: body.body, labels: body.labels.map((name) => ({ name })), state: 'open', comments: 0, list: [] };
      issues.set(issue.number, issue);
      return send(201, issue);
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/repos/o/r/contents/')) {
      files.push(url.pathname);
      return send(201, {});
    }
    if ((m = url.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/))) {
      const issue = issues.get(Number(m[1]));
      if (req.method === 'PATCH') issue.body = body.body;
      return send(200, issue);
    }
    if ((m = url.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/))) return send(200, issues.get(Number(m[1])).list);
    if (req.method === 'GET' && url.pathname === '/repos/o/r/issues') {
      return send(200, [...issues.values()].filter((issue) => issue.labels.some((label) => label.name === url.searchParams.get('labels'))));
    }
    send(404, {});
  });
});
await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve));
const githubUrl = `http://127.0.0.1:${github.address().port}`;

const config = join(work, 'config.php');
writeFileSync(
  config,
  `<?php return ['db_dsn' => 'sqlite:${join(work, 'db.sqlite')}', 'github_repo' => 'o/r', 'github_token' => 'test-token', 'github_api' => '${githubUrl}', 'salt' => 'pepper', 'allowed_origins' => ['*'], 'ideas_need_approval' => false];`,
);
const port = 18000 + Math.floor(Math.random() * 1000);
const php = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', relayDir], { env: { ...process.env, ZOOD_RELAY_CONFIG: config }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}/index.php`;
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`${base}?a=ping`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const call = async (action, body, query = '') => {
  const response = await fetch(`${base}?a=${action}${query}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Zood-App': '0.5.0' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
};

try {
  let r = await call('ping');
  assert.equal(r.data.ok, true);
  assert.equal(r.data.github, true);

  // Without the app's header: refused.
  r = { status: (await fetch(`${base}?a=ideas&install=${A}`)).status };
  assert.equal(r.status, 403);

  // A ticket with a picture and a log lands on GitHub as a private issue.
  const picture = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg').toString('base64');
  r = await call('ticket', { install: A, kind: 'bug', text: 'الحفظ لا يعمل @someone\nبعد التعديل', contact: 'a@b.c', app: 'ZOOD PDF 0.5.0 (desktop)', platform: 'Windows', lang: 'ar', screen: '1920×1080', log: 'line one', picture });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ticket = r.data;
  assert.match(ticket.id, /^[0-9a-f]{16}$/);
  assert.match(ticket.token, /^[0-9a-f]{32}$/);
  const issue = issues.get(ticket.number);
  assert.equal(issue.title, '[Ticket] الحفظ لا يعمل @someone');
  assert.ok(issue.body.includes('@​someone'), 'mentions are broken');
  assert.ok(issue.body.includes('line one'));
  assert.ok(issue.labels.some((l) => l.name === 'kind: bug'));
  assert.equal(files.length, 1);

  // Status: only with the right token and the same install.
  r = await call('status', null, `&install=${A}&tickets=${ticket.id}:${ticket.token}`);
  assert.equal(r.data.tickets[0].status, 'open');
  r = await call('status', null, `&install=${B}&tickets=${ticket.id}:${ticket.token}`);
  assert.equal(r.data.tickets.length, 0, 'another install cannot read it');
  r = await call('status', null, `&install=${A}&tickets=${ticket.id}:${'0'.repeat(32)}`);
  assert.equal(r.data.tickets.length, 0, 'a wrong token cannot read it');

  // Ideas: post, vote from another install, toggle off, one vote each.
  r = await call('idea', { install: A, title: 'دمج مع واتساب', body: 'إرسال الملف مباشرة', lang: 'ar' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const idea = r.data.idea;
  assert.equal(idea.votes, 1);
  r = await call('idea', { install: A, title: 'spam www.example.com', body: '' });
  assert.equal(r.status, 400);
  r = await call('vote', { install: B, idea: idea.id, on: true });
  assert.equal(r.data.votes, 2);
  r = await call('vote', { install: B, idea: idea.id, on: true });
  assert.equal(r.data.votes, 2, 'a second vote from one install is not counted');
  r = await call('ideas', null, `&install=${B}`);
  assert.equal(r.data.ideas[0].voted, true);
  assert.equal(r.data.ideas[0].mine, false);
  r = await call('vote', { install: B, idea: idea.id, on: false });
  assert.equal(r.data.votes, 1);

  // Labels on GitHub come back: ticket in progress, then fixed with a reply; idea planned.
  const ideaIssue = [...issues.values()].find((one) => one.title.startsWith('[Idea]'));
  ideaIssue.labels.push({ name: 'planned' });
  r = await call('vote', { install: B, idea: idea.id, on: true });
  const sync = spawn('php', [join(relayDir, 'sync.php')], { env: { ...process.env, ZOOD_RELAY_CONFIG: config } });
  let out = '';
  sync.stdout.on('data', (d) => (out += d));
  await new Promise((resolve) => sync.on('close', resolve));
  assert.equal(JSON.parse(out).votes, 1, out);
  assert.ok(ideaIssue.body.includes('**Votes: 2**'));
  r = await call('ideas', null, `&install=${A}`);
  assert.equal(r.data.ideas[0].status, 'planned');

  issue.state = 'closed';
  issue.labels.push({ name: 'fixed in 0.5.1' });
  issue.comments = 1;
  issue.list = [{ body: 'Reply: أصلحناه، حدّث التطبيق.', author_association: 'OWNER' }];
  // The status is cached for ten minutes; a fresh ticket shows the path instead.
  r = await call('ticket', { install: A, kind: 'file', text: 'second report here' });
  const second = r.data;
  const secondIssue = issues.get(second.number);
  secondIssue.state = 'closed';
  secondIssue.labels.push({ name: 'fixed in 0.5.1' });
  secondIssue.comments = 1;
  secondIssue.list = [{ body: 'reply: fixed, please update\n\n---\n_Generated by a tool_', author_association: 'OWNER' }, { body: 'Reply: not me', author_association: 'NONE' }];
  r = await call('status', null, `&install=${A}&tickets=${second.id}:${second.token}`);
  assert.deepEqual(r.data.tickets[0], { id: second.id, status: 'resolved', fixedIn: '0.5.1', reply: 'fixed, please update' });

  // Too many tickets from one install in an hour: 429.
  for (let i = 0; i < 3; i++) await call('ticket', { install: A, kind: 'other', text: `report number ${i}` });
  r = await call('ticket', { install: A, kind: 'other', text: 'one too many' });
  assert.equal(r.status, 429);

  console.log('support relay: all checks passed');
} finally {
  php.kill();
  github.close();
}
