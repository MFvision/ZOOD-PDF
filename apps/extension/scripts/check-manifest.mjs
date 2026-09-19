#!/usr/bin/env node
// Validates the Warraq extension manifest and the files it points at.
// Usage: node scripts/check-manifest.mjs [path/to/manifest.json]
// Default: the source manifest next to this package; pass dist/manifest.json
// after a build to validate the packaged tree. Exits 1 with a list of errors.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
const ALLOWED_PERMISSIONS = new Set(['contextMenus', 'storage', 'offscreen']);

const manifestPath = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../manifest.json', import.meta.url)),
);
const root = dirname(manifestPath);
const errors = [];
const warnings = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

let manifest;
try {
  manifest = readJson(manifestPath);
} catch (e) {
  console.error(`check-manifest: cannot read ${manifestPath}: ${e.message}`);
  process.exit(1);
}

// Core keys
if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
// The name is محرر PDF in every language, through the locale files.
if (manifest.name !== '__MSG_extName__')
  errors.push(`name must be "__MSG_extName__" (got ${JSON.stringify(manifest.name)})`);
for (const locale of ['ar', 'en']) {
  const name = readJson(join(root, '_locales', locale, 'messages.json')).extName?.message;
  if (name !== 'محرر PDF') errors.push(`_locales/${locale} extName must be "محرر PDF" (got ${JSON.stringify(name)})`);
}
if (typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  errors.push(
    `version must be 1-4 dot-separated integers (got ${JSON.stringify(manifest.version)})`,
  );
}
if (typeof manifest.description !== 'string' || !manifest.description)
  errors.push('description is required');
if (manifest.default_locale !== 'ar')
  errors.push(`default_locale must be "ar" (got ${JSON.stringify(manifest.default_locale)})`);

// Permissions: minimal, no host permissions in Phase 1
const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
for (const p of perms)
  if (!ALLOWED_PERMISSIONS.has(p))
    errors.push(`permission ${JSON.stringify(p)} is not in the Phase 1 allow-list`);
for (const p of ALLOWED_PERMISSIONS)
  if (!perms.includes(p)) errors.push(`permission ${JSON.stringify(p)} is missing`);
for (const key of [
  'host_permissions',
  'optional_host_permissions',
  'content_scripts',
  'web_accessible_resources',
]) {
  if (manifest[key] && (!Array.isArray(manifest[key]) || manifest[key].length > 0)) {
    errors.push(`${key} must be absent in Phase 1`);
  }
}

// CSP
const csp = manifest.content_security_policy?.extension_pages;
if (csp !== REQUIRED_CSP)
  errors.push(
    `content_security_policy.extension_pages must be exactly ${JSON.stringify(REQUIRED_CSP)} (got ${JSON.stringify(csp)})`,
  );
if (typeof csp === 'string' && /unsafe-eval|https?:|\*/.test(csp.replace("'wasm-unsafe-eval'", '')))
  errors.push('CSP must not allow eval or remote scripts');
if (manifest.content_security_policy?.sandbox)
  warnings.push('sandbox CSP is set; not used in Phase 1');

// Files referenced by the manifest
function mustExist(rel, what) {
  if (typeof rel !== 'string' || !existsSync(join(root, rel)))
    errors.push(`${what} ${JSON.stringify(rel)} does not exist under ${root}`);
}
mustExist(manifest.background?.service_worker, 'background.service_worker');
for (const [size, file] of Object.entries(manifest.icons ?? {})) mustExist(file, `icons[${size}]`);
if (!manifest.icons || !manifest.icons['128'])
  errors.push('icons must include a 128px icon (store listing)');
if (manifest.action) {
  for (const [size, file] of Object.entries(manifest.action.default_icon ?? {}))
    mustExist(file, `action.default_icon[${size}]`);
} else {
  warnings.push('no action (toolbar button) declared');
}

// Locales: every __MSG_key__ used in the manifest must exist in the default locale
const localesDir = join(root, '_locales');
const defaultLocale = manifest.default_locale;
const messagesPath = join(localesDir, defaultLocale ?? '', 'messages.json');
let messages = {};
if (!existsSync(messagesPath)) {
  errors.push(`_locales/${defaultLocale}/messages.json is missing`);
} else {
  try {
    messages = readJson(messagesPath);
  } catch (e) {
    errors.push(`_locales/${defaultLocale}/messages.json is not valid JSON: ${e.message}`);
  }
}
const used = new Set();
for (const m of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) used.add(m[1]);
for (const key of used) {
  if (!messages[key] || typeof messages[key].message !== 'string' || !messages[key].message) {
    errors.push(
      `message ${JSON.stringify(key)} used in the manifest is missing from _locales/${defaultLocale}/messages.json`,
    );
  }
}
if (existsSync(localesDir)) {
  for (const locale of readdirSync(localesDir)) {
    const p = join(localesDir, locale, 'messages.json');
    if (!existsSync(p)) {
      errors.push(`_locales/${locale}/messages.json is missing`);
      continue;
    }
    let other;
    try {
      other = readJson(p);
    } catch (e) {
      errors.push(`_locales/${locale}/messages.json is not valid JSON: ${e.message}`);
      continue;
    }
    for (const key of Object.keys(messages))
      if (!other[key])
        warnings.push(`_locales/${locale}: message ${JSON.stringify(key)} is not translated`);
  }
}

// viewer.html: must exist and contain no inline scripts (the CSP would block them)
const viewerPath = join(root, 'viewer.html');
if (!existsSync(viewerPath)) {
  errors.push('viewer.html is missing');
} else {
  const html = readFileSync(viewerPath, 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (!/\bsrc\s*=/.test(attrs))
      errors.push(
        'viewer.html contains an inline <script>; the extension CSP blocks inline scripts',
      );
    const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1];
    if (src && /^(https?:)?\/\//.test(src)) errors.push(`viewer.html loads a remote script ${src}`);
    if (src && !/^(https?:)?\/\//.test(src) && manifestPath.includes(`${'dist'}`)) {
      const rel = src.replace(/^\.?\//, '');
      if (!existsSync(join(root, rel)))
        errors.push(`viewer.html references ${src} which is not in the package`);
    }
  }
  if (/\son[a-z]+\s*=/i.test(html))
    errors.push('viewer.html uses inline event handlers; the extension CSP blocks them');
}

for (const w of warnings) console.warn(`check-manifest: warning: ${w}`);
if (errors.length) {
  console.error(`check-manifest: ${manifestPath}`);
  for (const e of errors) console.error(`  error: ${e}`);
  process.exit(1);
}
console.log(
  `check-manifest: OK (${manifestPath}; ${perms.length} permissions, ${used.size} localized strings)`,
);
