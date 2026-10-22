import { ABOUT } from '../settings/about';

/**
 * Where Help & Support sends what the person chooses to send. One place, so
 * the app, the website and the relay never disagree.
 *
 * The relay is a small PHP script on ZOOD's own hosting
 * (`website/api/support/`, see its README). Until it is uploaded the app asks
 * it once, finds nothing, and offers e-mail instead: nothing in the app
 * waits on it, and it starts working by itself the day it answers.
 */
export const SUPPORT = {
  relay: 'https://pdf.zood.sa/api/support/',
  email: ABOUT.email,
  /** How long a request may take before the app stops waiting and offers e-mail. */
  timeoutMs: 8000,
  /** The website's help pages, the same articles as the app's. */
  website: { ar: 'https://pdf.zood.sa/help/', en: 'https://pdf.zood.sa/en/help/' },
} as const;

export { LIMITS } from './limits';
