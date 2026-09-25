import fs from 'node:fs';
import type { Plugin } from 'vite';

/**
 * Known trap: a `<meta http-equiv="Content-Security-Policy">` in the page *intersects* with the
 * CSP Tauri sends as a header (tauri.conf.json → app.security.csp), so e.g. `ipc:` or
 * `http://ipc.localhost` missing from the web CSP would silently break every IPC call.
 * The desktop build removes the meta tag; the header CSP is the only policy.
 */
const META_CSP = /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?)[^>]*>\s*/gi;

export function stripMetaCsp(html: string): string {
  return html.replace(META_CSP, '');
}

export function hasMetaCsp(html: string): boolean {
  META_CSP.lastIndex = 0;
  const found = META_CSP.test(html);
  META_CSP.lastIndex = 0;
  return found;
}

const MANIFEST_LINK = /<link\b(?=[^>]*\brel\s*=\s*["']?manifest["']?)[^>]*>\s*/gi;

/** The web page as the desktop page: CSP meta and PWA manifest removed, `./src/main.ts` kept
 *  (apps/desktop/src/main.ts sits at the same relative path as the web entry). */
export function desktopHtmlFromWeb(webHtml: string): string {
  return stripMetaCsp(webHtml).replace(MANIFEST_LINK, '');
}

/** Serves apps/web/index.html in place of apps/desktop/index.html ("same entry as web"). */
export function webShell(webIndex: string): Plugin {
  return {
    name: 'zood-desktop:web-shell',
    transformIndexHtml: {
      order: 'pre',
      handler: () => desktopHtmlFromWeb(fs.readFileSync(webIndex, 'utf8')),
    },
  };
}

export function zoodDesktop(): Plugin {
  return {
    name: 'zood-desktop',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => stripMetaCsp(html),
    },
    generateBundle(_options, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (!name.endsWith('.html') || chunk.type !== 'asset') continue;
        const html = typeof chunk.source === 'string' ? chunk.source : new TextDecoder().decode(chunk.source);
        if (hasMetaCsp(html)) this.error(`${name} still contains a <meta> CSP (it would intersect Tauri's CSP)`);
      }
    },
  };
}
