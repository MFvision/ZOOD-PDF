import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAUDE_ENDPOINT, LM_STUDIO_URL, LOCAL_ALLOWED_ORIGINS, LOCAL_DEFAULT_URL } from '@warraq/ui/src/ai/providers';
import { DEVICE_MODELS, MODEL_HOSTS } from '@warraq/ui/src/ai/device/models';
import { stripMetaCsp } from '../vite.config';
import { cloudConfig, oneDriveSources, shippedConfig, withCloudSources } from '../../../packages/ui/vite/cloudConfig';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/**
 * The only places the app may connect to besides itself: the AI tool's two
 * remote providers — Anthropic's API, for a person's own key, and the ports
 * Ollama and LM Studio listen on, on this computer — and, in a browser only,
 * Hugging Face and its CDN, for the one download of the on-device model.
 * Nothing is sent to any of them until the person presses Send, or the
 * download button. The desktop host downloads the model itself, so its
 * webview never reaches Hugging Face.
 */
const AI_SOURCES =
  'https://api.anthropic.com http://localhost:11434 http://127.0.0.1:11434 http://localhost:1234 http://127.0.0.1:1234';
const MODEL_SOURCES = 'https://huggingface.co https://*.hf.co';

const EXPECTED_CSP =
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; worker-src 'self' blob:; frame-src blob:; connect-src 'self' ${AI_SOURCES} ${MODEL_SOURCES}; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;

describe('apps/web index.html', () => {
  it('ships the strict Content-Security-Policy', () => {
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${EXPECTED_CSP}" />`,
    );
  });

  it('has no inline scripts', () => {
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\bsrc=/);
  });

  it('defaults to Arabic and RTL before hydration', () => {
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });

  /*
   * A browser prints the file through its own PDF viewer: EmbedPDF puts the
   * file it made in a hidden frame, as a blob, and prints that. Framing
   * nothing at all (`default-src 'self'`) blocked it, and Print did nothing.
   */
  it('frames only a PDF the page made itself, to print it', () => {
    expect(directives(EXPECTED_CSP).get('frame-src')).toBe('blob:');
  });
});

/** `name -> sources`, so two policies can be compared directive by directive. */
function directives(csp: string): Map<string, string> {
  return new Map(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name = '', ...sources] = part.split(/\s+/);
        return [name, sources.join(' ')] as const;
      }),
  );
}

const desktopCsp = (
  JSON.parse(
    readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { app: { security: { csp: string } } }
).app.security.csp;

/**
 * One document, two hosts, and only one of them may carry a policy.
 *
 * A browser gets it from the meta tag above, because a static host has nowhere
 * else to put one. The desktop host gets it from `tauri.conf.json`, which Tauri
 * extends at runtime with the nonces its injected scripts carry and the origin
 * its IPC uses. Ship both and the browser enforces the intersection: the
 * meta tag, knowing nothing of either, silently cut the interface off from its
 * own host — the app opened, and could then do nothing at all.
 */
describe('the desktop policy replaces the document one', () => {
  it('strips the meta tag from the bundle the desktop embeds', () => {
    const transform = stripMetaCsp().transformIndexHtml as (html: string) => string;
    const stripped = transform(html);
    expect(stripped).not.toContain('Content-Security-Policy');
    expect(stripped).toContain('<div id="root"></div>');
  });

  it('is no weaker than the document policy it replaces', () => {
    const web = directives(EXPECTED_CSP);
    const desktop = directives(desktopCsp);
    for (const [name, sources] of web) {
      expect(desktop.has(name), `${name} is missing from the desktop policy`).toBe(true);
      // connect-src is the one that has to differ; everything else must match.
      if (name !== 'connect-src') expect(desktop.get(name)).toBe(sources);
    }
  });

  it('lets the desktop reach its own IPC, which the document policy cannot know about', () => {
    expect(directives(desktopCsp).get('connect-src')).toBe(`'self' ipc: http://ipc.localhost ${AI_SOURCES}`);
  });
});

describe('the AI tool can reach its providers, and nothing else is opened up', () => {
  it('adds the same sources to both policies, and only these', () => {
    const extra = (connect: string | undefined, own: string[]) =>
      (connect ?? '').split(' ').filter((source) => !own.includes(source));
    expect(extra(directives(EXPECTED_CSP).get('connect-src'), ["'self'"])).toEqual([...AI_SOURCES.split(' '), ...MODEL_SOURCES.split(' ')]);
    expect(extra(directives(desktopCsp).get('connect-src'), ["'self'", 'ipc:', 'http://ipc.localhost'])).toEqual(
      AI_SOURCES.split(' '),
    );
  });

  it('allows exactly the addresses the tool uses by default', () => {
    expect(AI_SOURCES.split(' ')).toEqual([new URL(CLAUDE_ENDPOINT).origin, ...LOCAL_ALLOWED_ORIGINS]);
    // The model's catalogue and the policy name the same hosts; the desktop host checks each redirect against them itself.
    expect(MODEL_SOURCES.split(' ')).toEqual([...MODEL_HOSTS]);
    for (const model of DEVICE_MODELS) expect(new URL(model.url).origin).toBe('https://huggingface.co');
    expect(LOCAL_ALLOWED_ORIGINS).toContain(new URL(LOCAL_DEFAULT_URL).origin);
    expect(LOCAL_ALLOWED_ORIGINS).toContain(new URL(LM_STUDIO_URL).origin);
  });
});

describe('the cloud drives reach exactly their own hosts, and only in a build that offers them', () => {
  const ONEDRIVE = [
    'https://login.microsoftonline.com',
    'https://graph.microsoft.com',
    'https://*.1drv.com',
    'https://*.sharepoint.com',
    'https://*.microsoftpersonalcontent.com',
  ];
  const APP = '0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22';
  const GOOGLE = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';

  it('leaves the policy as it is when no drive is configured', () => {
    expect(withCloudSources(html, {})).toBe(html);
    expect(withCloudSources(html, { gdrive: { clientId: GOOGLE } })).toBe(html);
  });

  it('adds OneDrive’s hosts to connect-src, and changes nothing else, when OneDrive is configured', () => {
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(withCloudSources(html, { onedrive: { clientId: APP, tenant: 'common' } }))?.[1] ?? '';
    const cloud = directives(csp);
    for (const [name, sources] of directives(EXPECTED_CSP)) if (name !== 'connect-src') expect(cloud.get(name)).toBe(sources);
    expect(cloud.get('connect-src')).toBe(`'self' ${AI_SOURCES} ${MODEL_SOURCES} ${ONEDRIVE.join(' ')}`);
    expect(oneDriveSources()).toEqual(ONEDRIVE);
  });

  it('ships no Google Drive to a browser, and the desktop policy names no drive: the host sends those requests', () => {
    const both = { onedrive: { clientId: APP, tenant: 'common' }, gdrive: { clientId: GOOGLE } };
    expect(shippedConfig(both, 'production')).toEqual({ onedrive: both.onedrive });
    expect(shippedConfig(both, 'tauri')).toEqual(both);
    expect(desktopCsp).not.toMatch(/microsoft|1drv|sharepoint|googleapis/);
  });

  it('fails a build whose client ID cannot be an app’s, and ships none when none is set', () => {
    expect(() => cloudConfig('production', { WARRAQ_ONEDRIVE_CLIENT_ID: 'not-a-guid' })).toThrow(/GUID/);
    const defined = (env: Record<string, string>) =>
      JSON.parse((cloudConfig('production', env).config as () => { define: Record<string, string> })().define.__WARRAQ_CLOUD__ ?? '') as unknown;
    expect(defined({ WARRAQ_ONEDRIVE_CLIENT_ID: APP })).toEqual({ onedrive: { clientId: APP, tenant: 'common' } });
    expect(defined({})).toEqual({});
  });

  it('gives the sign-in window’s return page a policy of its own: its one script, and nothing reached', () => {
    const callback = readFileSync(new URL('../oauth-callback.html', import.meta.url), 'utf8');
    expect(callback).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" />`,
    );
    expect(callback).toContain('<meta name="referrer" content="no-referrer" />');
  });
});
