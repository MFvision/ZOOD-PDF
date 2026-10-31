const { chromium } = require('playwright'); const jobs = require('./jobs.json');
(async () => { const b = await chromium.launch(); const p = await b.newPage();
for (const j of jobs) { await p.goto('file://' + __dirname + '/' + j + '.html'); await p.waitForTimeout(300); await p.pdf({ path: j + '.pdf', format: 'A4', preferCSSPageSize: true }); }
await b.close(); })();
