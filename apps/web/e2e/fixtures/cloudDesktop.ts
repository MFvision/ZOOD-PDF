import type { CloudConfig, ProviderId } from '@warraq/ui/src/cloud/config';
import { kindOf } from '@warraq/ui/src/cloud/errors';
import { pickedIds } from '@warraq/ui/src/cloud/gdrive';
import { desktopHost } from '@warraq/ui/src/cloud/host';
import { googlePicker } from '@warraq/ui/src/cloud/oauth';
import { CloudService } from '@warraq/ui/src/cloud/service';

/**
 * The desktop app's own cloud code — the service, the host broker, the
 * transport through the host's commands, the loopback sign-in — driven from
 * a test page (`cloud-desktop.spec.ts`). Everything below `desktopHost()` is
 * the shipped code; only the host answering its commands is the test's, which
 * is what the Rust tests cover on the other side.
 */

declare global {
  interface Window {
    cloudDesktop?: ReturnType<typeof harness>;
  }
}

/** What a step answers: a value, or the kind of error the interface would show. */
type Step<T> = Promise<T | { error: string }>;

async function attempt<T>(work: () => Promise<T>): Step<T> {
  try {
    return await work();
  } catch (error) {
    return { error: kindOf(error), detail: String(error) } as { error: string };
  }
}

const text = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
const bytesOf = (body: string) => new TextEncoder().encode(body).buffer as ArrayBuffer;

export function harness(config: CloudConfig) {
  const service = new CloudService(config, desktopHost());
  return {
    providers: service.providers,

    /** Signs in in the system browser; for Google, `purpose` asks for its picker in the consent screen. */
    signIn: (provider: ProviderId, purpose?: 'open' | 'folder') =>
      attempt(async () => {
        const { account, params } = await service.signIn(provider, {
          extra: provider === 'gdrive' && purpose ? googlePicker(purpose) : undefined,
        });
        return { account, picked: pickedIds(params) };
      }),

    ready: (provider: ProviderId) => attempt(() => service.ready(provider)),

    list: (provider: ProviderId, folder: string | null, query?: string) =>
      attempt(async () => {
        const drive = service.drive(provider);
        const listing = query ? await drive.search(query) : await drive.list(folder);
        return listing.entries.map((entry) => ({ key: entry.key, name: entry.name, kind: entry.kind }));
      }),

    open: (provider: ProviderId, key: string) =>
      attempt(async () => {
        const opened = await service.drive(provider).open(key);
        return { key: opened.key, name: opened.name, version: opened.version, parentKey: opened.parentKey, text: text(opened.bytes) };
      }),

    /** A new revision of an opened file, checked against `version` (null replaces whatever is there). */
    saveRevision: (provider: ProviderId, key: string, version: string | null, body: string) =>
      attempt(async () => {
        const saved = await service.drive(provider).saveRevision(key, bytesOf(body), version);
        return { key: saved.key, name: saved.name, version: saved.version };
      }),

    saveNew: (provider: ProviderId, folder: string | null, name: string, body: string) =>
      attempt(async () => {
        const saved = await service.drive(provider).saveNew(folder, name, bytesOf(body), 'fail');
        return { key: saved.key, name: saved.name, version: saved.version, parentKey: saved.parentKey };
      }),

    signOut: (provider: ProviderId) => attempt(() => service.signOut(provider)),
  };
}

export function install(config: CloudConfig): void {
  window.cloudDesktop = harness(config);
}
