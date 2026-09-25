// Probes the desktop security posture from inside the real webview. Each check states what
// must happen; the Rust side prints the report (smoke mode only) and the script greps it.
const I = window.__TAURI_INTERNALS__;
const failures = [];
const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error) }));

async function expectDenied(name, promise) {
  const r = await settle(promise);
  if (r.ok) failures.push(`${name} was allowed`);
}
async function expectAllowed(name, promise, check = () => true) {
  const r = await settle(promise);
  if (!r.ok) failures.push(`${name} denied: ${r.error.slice(0, 120)}`);
  else if (!check(r.value)) failures.push(`${name} returned ${JSON.stringify(r.value).slice(0, 120)}`);
}

(async () => {
  // Capabilities: nothing outside the list, fs only inside the dialog/drop scope.
  await expectDenied('fs read_dir', I.invoke('plugin:fs|read_dir', { path: '/etc' }));
  await expectDenied('fs read_file outside scope', I.invoke('plugin:fs|read_file', { path: '/etc/hostname' }));
  await expectDenied('fs remove', I.invoke('plugin:fs|remove', { path: '/tmp/x' }));
  await expectDenied('shell open', I.invoke('plugin:shell|open', { path: 'https://example.com' }));
  await expectDenied('window close', I.invoke('plugin:window|close', { label: 'main' }));
  // CSP: no eval, no inline script.
  // eslint-disable-next-line no-eval -- the probe proves the CSP blocks eval
  await expectDenied('eval', Promise.resolve().then(() => (0, eval)('1+1')));
  // eslint-disable-next-line no-new-func -- the probe proves the CSP blocks new Function
  await expectDenied('new Function', Promise.resolve().then(() => new Function('return 1')()));
  await expectDenied('remote fetch', fetch('https://example.com/', { cache: 'no-store' }));
  // App commands.
  await expectAllowed('host_info', I.invoke('host_info'), (i) => i.os === 'linux' && i.nativePdfPrint === false && i.smoke === true);
  await expectAllowed('suggest_save_path', I.invoke('suggest_save_path', { name: '../../x<y>.pdf' }), (p) =>
    p.endsWith('x_y_.pdf') && !p.includes('..'),
  );
  await expectDenied('set_menu invalid', I.invoke('set_menu', { model: '{"menus":[{"label":"","items":[]}]}' }));
  await expectAllowed(
    'set_menu valid',
    I.invoke('set_menu', { model: '{"menus":[{"label":"ملف","items":[{"type":"item","id":"a","label":"فتح"}]}]}' }),
    (v) => v === false,
  );
  await expectDenied('print_pdf on Linux', I.invoke('print_pdf', new Uint8Array([37, 80, 68, 70, 45])));
  await expectAllowed('set_locale', I.invoke('set_locale', { locale: 'ar' }));

  const report = failures.length === 0 ? 'PROBE_OK' : `PROBE_FAIL ${failures.join(' ; ')}`;
  document.getElementById('out').textContent = report;
  await I.invoke('app_ready', { report });
})();
