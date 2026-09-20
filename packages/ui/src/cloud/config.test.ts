import { describe, expect, it } from 'vitest';
import { configFromEnvironment, offeredProviders, sanitizeConfig } from './config';

const APP = '0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22';
const GOOGLE = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';

describe('the cloud configuration of a build', () => {
  it('offers nothing when nothing is configured', () => {
    expect(configFromEnvironment({})).toEqual({});
    expect(configFromEnvironment({ WARRAQ_ONEDRIVE_CLIENT_ID: '  ', WARRAQ_GOOGLE_CLIENT_ID: '' })).toEqual({});
    expect(offeredProviders({}, true)).toEqual([]);
    expect(offeredProviders({}, false)).toEqual([]);
  });

  it('takes a OneDrive app with the common audience unless a tenant is named', () => {
    expect(configFromEnvironment({ WARRAQ_ONEDRIVE_CLIENT_ID: APP.toUpperCase() })).toEqual({
      onedrive: { clientId: APP, tenant: 'common' },
    });
    for (const tenant of ['consumers', 'organizations', APP, 'contoso.onmicrosoft.com']) {
      expect(configFromEnvironment({ WARRAQ_ONEDRIVE_CLIENT_ID: APP, WARRAQ_ONEDRIVE_TENANT: tenant }).onedrive?.tenant).toBe(tenant);
    }
  });

  it('fails the build on a value that is set but cannot be an app, rather than ship a button that cannot sign in', () => {
    expect(() => configFromEnvironment({ WARRAQ_ONEDRIVE_CLIENT_ID: 'my-app' })).toThrow(/GUID/);
    expect(() => configFromEnvironment({ WARRAQ_ONEDRIVE_CLIENT_ID: APP, WARRAQ_ONEDRIVE_TENANT: 'a/b' })).toThrow(/TENANT/);
    expect(() => configFromEnvironment({ WARRAQ_GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com' })).toThrow(/Google/);
    expect(configFromEnvironment({ WARRAQ_GOOGLE_CLIENT_ID: GOOGLE })).toEqual({ gdrive: { clientId: GOOGLE } });
  });

  it('offers Google Drive on the desktop only, where no client secret is needed for its picker', () => {
    const config = { onedrive: { clientId: APP, tenant: 'common' }, gdrive: { clientId: GOOGLE } };
    expect(offeredProviders(config, true)).toEqual(['onedrive', 'gdrive']);
    expect(offeredProviders(config, false)).toEqual(['onedrive']);
  });

  it('trusts in the page only what passes the same checks', () => {
    expect(sanitizeConfig(undefined)).toEqual({});
    expect(sanitizeConfig({ onedrive: { clientId: 'x', tenant: 'common' } })).toEqual({});
    expect(sanitizeConfig({ onedrive: { clientId: APP, tenant: 'common' }, gdrive: { clientId: 5 } })).toEqual({
      onedrive: { clientId: APP, tenant: 'common' },
    });
  });
});
