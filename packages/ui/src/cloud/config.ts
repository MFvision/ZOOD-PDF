/**
 * Which cloud drives a build offers, and as which registered app.
 *
 * The client IDs are the build's configuration — `WARRAQ_ONEDRIVE_CLIENT_ID`,
 * `WARRAQ_ONEDRIVE_TENANT` and `WARRAQ_GOOGLE_CLIENT_ID` in the environment
 * of `vite build` (docs/cloud.md says how to register each app) — handed to
 * the interface as `__WARRAQ_CLOUD__` by `packages/ui/vite/cloudConfig.ts`.
 * None is invented here: a build without them offers no drive, and shows no
 * cloud control anywhere. There is no client secret, and no place for one.
 *
 * The same validation runs in the build (a mistyped ID fails it, rather
 * than shipping buttons that cannot sign in) and in the page.
 */

export type ProviderId = 'onedrive' | 'gdrive';

export const PROVIDERS: readonly ProviderId[] = ['onedrive', 'gdrive'];

export interface OneDriveConfig {
  /** The Microsoft Entra app's Application (client) ID, a GUID. */
  clientId: string;
  /** `common` (personal and work accounts), `consumers`, `organizations`, or one tenant. */
  tenant: string;
}

export interface GoogleConfig {
  /** A Google Cloud OAuth client of type "Desktop app". */
  clientId: string;
}

export interface CloudConfig {
  onedrive?: OneDriveConfig;
  gdrive?: GoogleConfig;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tenant ID, a verified domain, or one of the three audiences. */
const TENANT = /^(common|consumers|organizations|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
const GOOGLE_CLIENT = /^[0-9]{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/;

/** Why a configured value was refused, or `null` when it is a valid one. */
export function oneDriveProblem(clientId: string, tenant: string): string | null {
  if (!GUID.test(clientId)) return `WARRAQ_ONEDRIVE_CLIENT_ID must be the app's Application (client) ID, a GUID; got ${JSON.stringify(clientId)}`;
  if (!TENANT.test(tenant)) return `WARRAQ_ONEDRIVE_TENANT must be common, consumers, organizations, a tenant ID or a domain; got ${JSON.stringify(tenant)}`;
  return null;
}

export function googleProblem(clientId: string): string | null {
  return GOOGLE_CLIENT.test(clientId)
    ? null
    : `WARRAQ_GOOGLE_CLIENT_ID must be a Google OAuth client ID (…apps.googleusercontent.com); got ${JSON.stringify(clientId)}`;
}

/**
 * The configuration from the environment of a build: `null` fields where a
 * variable is unset or empty. Throws on a value that is set but invalid.
 */
export function configFromEnvironment(env: Record<string, string | undefined>): CloudConfig {
  const config: CloudConfig = {};
  const oneDrive = env.WARRAQ_ONEDRIVE_CLIENT_ID?.trim();
  if (oneDrive) {
    const tenant = env.WARRAQ_ONEDRIVE_TENANT?.trim() || 'common';
    const problem = oneDriveProblem(oneDrive, tenant);
    if (problem) throw new Error(problem);
    config.onedrive = { clientId: oneDrive.toLowerCase(), tenant };
  }
  const google = env.WARRAQ_GOOGLE_CLIENT_ID?.trim();
  if (google) {
    const problem = googleProblem(google);
    if (problem) throw new Error(problem);
    config.gdrive = { clientId: google };
  }
  return config;
}

/** What the page trusts of `__WARRAQ_CLOUD__`: only values that pass the same checks. */
export function sanitizeConfig(raw: unknown): CloudConfig {
  const config: CloudConfig = {};
  if (!raw || typeof raw !== 'object') return config;
  const { onedrive, gdrive } = raw as Record<string, unknown>;
  if (onedrive && typeof onedrive === 'object') {
    const { clientId, tenant } = onedrive as Record<string, unknown>;
    if (typeof clientId === 'string' && typeof tenant === 'string' && oneDriveProblem(clientId, tenant) === null) {
      config.onedrive = { clientId, tenant };
    }
  }
  if (gdrive && typeof gdrive === 'object') {
    const { clientId } = gdrive as Record<string, unknown>;
    if (typeof clientId === 'string' && googleProblem(clientId) === null) config.gdrive = { clientId };
  }
  return config;
}

declare const __WARRAQ_CLOUD__: unknown;

/** This build's configuration. The extension's build defines none. */
export function builtConfig(): CloudConfig {
  return sanitizeConfig(typeof __WARRAQ_CLOUD__ === 'undefined' ? null : __WARRAQ_CLOUD__);
}

/**
 * The drives offered on a host. OneDrive in a browser and on the desktop;
 * Google Drive on the desktop only: Google redeems no authorization code
 * from a browser app without a client secret (docs/cloud.md), and there is
 * none.
 */
export function offeredProviders(config: CloudConfig, desktop: boolean): ProviderId[] {
  const offered: ProviderId[] = [];
  if (config.onedrive) offered.push('onedrive');
  if (config.gdrive && desktop) offered.push('gdrive');
  return offered;
}
