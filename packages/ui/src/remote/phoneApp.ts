/**
 * Where a phone gets the ZOOD PDF app, for the code the welcome tour shows.
 *
 * The code always points at the website's /app page, never at a store, so
 * the store link can change without a new app: put the TestFlight public
 * link (now) or the App Store link (later) in website/js/phone-app.js and
 * upload the site. A phone that scans the code then lands in the store; any
 * other phone sees the page with the buttons.
 *
 * PHONE_APP_QR is that link drawn as a QR code (version 2, level M, 25 x 25
 * modules, one dark run per segment). If PHONE_APP_LINK ever changes, draw
 * it again, for example with Python's segno:
 *   segno.make(LINK, error='m').save(out, kind='svg', border=0, xmldecl=False)
 * and copy the path's d attribute here.
 */
export const PHONE_APP_LINK = 'https://pdf.zoodrealty.com/app';

/** The link as people read it under the code. */
export const PHONE_APP_LINK_SHORT = 'pdf.zoodrealty.com/app';

export const PHONE_APP_QR_SIZE = 25;

export const PHONE_APP_QR =
  'M0 0.5h7m1 0h2m3 0h1m4 0h7m-25 1h1m5 0h1m2 0h3m1 0h1m4 0h1m5 0h1m-25 1h1m1 0h3m1 0h1m1 0h2m2 0h2m4 0h1m1 0h3m1 0h1m-25 1h1m1 0h3m1 0h1m2 0h2m2 0h3m2 0h1m1 0h3m1 0h1m-25 1h1m1 0h3m1 0h1m3 0h5m1 0h1m1 0h1m1 0h3m1 0h1m-25 1h1m5 0h1m1 0h4m6 0h1m5 0h1m-25 1h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7m-16 1h2m1 0h1m1 0h1m1 0h1m-17 1h1m1 0h1m3 0h2m1 0h3m2 0h3m2 0h1m2 0h1m1 0h1m-25 1h2m2 0h2m2 0h1m1 0h4m1 0h2m1 0h2m1 0h1m1 0h2m-25 1h1m1 0h2m1 0h3m1 0h1m1 0h2m2 0h1m2 0h5m1 0h1m-24 1h4m2 0h3m4 0h3m4 0h1m-16 1h1m1 0h1m2 0h1m4 0h1m1 0h1m5 0h1m-22 1h1m1 0h1m4 0h1m4 0h2m1 0h2m3 0h2m-25 1h2m1 0h1m1 0h2m2 0h1m1 0h1m1 0h3m2 0h1m2 0h2m1 0h1m-23 1h3m3 0h1m1 0h1m3 0h3m1 0h4m-22 1h2m1 0h1m1 0h2m1 0h1m2 0h2m3 0h5m2 0h1m-16 1h3m1 0h1m1 0h1m1 0h1m3 0h1m3 0h1m-25 1h7m1 0h2m2 0h3m1 0h1m1 0h1m1 0h1m3 0h1m-25 1h1m5 0h1m3 0h3m2 0h2m3 0h1m2 0h2m-25 1h1m1 0h3m1 0h1m5 0h1m2 0h6m3 0h1m-25 1h1m1 0h3m1 0h1m2 0h2m3 0h1m1 0h1m3 0h1m1 0h2m-24 1h1m1 0h3m1 0h1m1 0h8m1 0h1m1 0h3m1 0h2m-25 1h1m5 0h1m2 0h1m5 0h6m-21 1h7m1 0h7m1 0h2m3 0h1m2 0h1';
