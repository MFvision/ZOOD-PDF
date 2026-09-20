/**
 * The page a browser sign-in comes back to (`apps/web/oauth-callback.html`)
 * and how it speaks to the app window: shared by that page and `signin.ts`.
 */

/** Beside the app's own page: registered as the redirect URI of the browser build. */
export const CALLBACK_PAGE = 'oauth-callback.html';

/** The broadcast channel the page speaks on: its opener may have been cut off by the provider's pages. */
export const CALLBACK_CHANNEL = 'warraq-oauth';

/** The type of the one message the page sends, with its own address. */
export const CALLBACK_MESSAGE = 'warraq:oauth';

export interface CallbackMessage {
  type: typeof CALLBACK_MESSAGE;
  url: string;
}
