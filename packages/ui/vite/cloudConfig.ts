import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { configFromEnvironment } from '../src/cloud/config';
import type { CloudConfig } from '../src/cloud/config';

/**
 * The cloud drives a build offers, from its environment (docs/cloud.md):
 *
 *   WARRAQ_ONEDRIVE_CLIENT_ID   the Microsoft app's Application (client) ID
 *   WARRAQ_ONEDRIVE_TENANT      common (default), consumers, organizations or a tenant
 *   WARRAQ_GOOGLE_CLIENT_ID     a Google "Desktop app" client, for the desktop build only
 *
 * They reach the interface as `__WARRAQ_CLOUD__`. None set: no drive, and
 * no cloud control anywhere. A value that cannot be an app's ID fails the
 * build. There is no secret to configure.
 *
 * The web page's security policy grows by OneDrive's hosts, and only when
 * OneDrive is configured: an unconfigured build can reach no drive at all.
 * The desktop build's policy never names them — its drives' requests are
 * sent by the host, in Rust (`src-tauri/src/cloud.rs`), to the same hosts.
 */

interface HostList {
  onedrive: string[];
  gdrive: string[];
}

const hosts = (): HostList =>
  JSON.parse(readFileSync(new URL('../src/cloud/hosts.json', import.meta.url), 'utf8')) as HostList;

/** What OneDrive adds to the web page's `connect-src`. */
export function oneDriveSources(): string[] {
  return hosts().onedrive.map((host) => `https://${host}`);
}

/**
 * What a build ships: the web build drops Google Drive, which Google lets a
 * browser app use only with a client secret (docs/cloud.md).
 */
export function shippedConfig(config: CloudConfig, mode: string): CloudConfig {
  return mode === 'tauri' ? config : config.onedrive ? { onedrive: config.onedrive } : {};
}

/** The page's policy with OneDrive's sources added to `connect-src`, when OneDrive is configured. */
export function withCloudSources(html: string, config: CloudConfig): string {
  if (!config.onedrive) return html;
  return html.replace(
    /(<meta http-equiv="Content-Security-Policy" content="[^"]*?connect-src )([^;"]*)/,
    (_, head: string, sources: string) => `${head}${sources} ${oneDriveSources().join(' ')}`,
  );
}

export function cloudConfig(mode: string, env: Record<string, string | undefined> = process.env): Plugin {
  const config = shippedConfig(configFromEnvironment(env), mode);
  return {
    name: 'warraq:cloud-config',
    config: () => ({ define: { __WARRAQ_CLOUD__: JSON.stringify(config) } }),
    transformIndexHtml: {
      order: 'pre',
      handler: (html, context) => (context.filename.endsWith('index.html') ? withCloudSources(html, config) : html),
    },
  };
}
