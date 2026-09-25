import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { zoodUi } from '@zood/ui/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Strict CSP for the web build. No inline or eval'd script; WebAssembly needs 'wasm-unsafe-eval';
 * EmbedPDF starts its PDFium worker from a blob: URL; its UI sets inline styles.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "manifest-src 'self'",
].join('; ');

/** Injects the CSP meta (production only: the dev server needs inline HMR scripts). */
function csp(): Plugin {
  return {
    name: 'zood:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
    },
  };
}

/** Emits sw.js with the list of shell files of THIS build (documents are never cached). */
function shellServiceWorker(): Plugin {
  let publicDir = '';
  return {
    name: 'zood:service-worker',
    apply: 'build',
    configResolved(c) {
      publicDir = c.publicDir;
    },
    generateBundle(_opts, bundle) {
      const files = new Set<string>(['./', './index.html']);
      for (const name of Object.keys(bundle)) if (!name.endsWith('.map')) files.add(`./${name}`);
      const walk = (dir: string, rel = ''): void => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
          else files.add(`./${rel}${e.name}`);
        }
      };
      walk(publicDir);
      const list = [...files].sort();
      const version = crypto.createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
      const template = fs.readFileSync(path.join(here, 'src/sw-template.js'), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template
          .replace(/^\/\* global .*\*\/\n/, '')
          .replaceAll('__ZOOD_VERSION__', version)
          .replaceAll('__ZOOD_SHELL__', JSON.stringify(list)),
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [zoodUi(), csp(), shellServiceWorker()],
  server: { port: 5173 },
  preview: { port: 4311, strictPort: true },
});
