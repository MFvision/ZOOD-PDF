/**
 * The ZOOD PDF app mark (original artwork): a sheet with a folded corner on a blue-to-violet tile; the
 * zig-zag stroke is both a "Z" and a signature line. The same drawing is exported as the PWA and
 * extension icons (apps/web/scripts/icons.mjs renders app-mark.svg to PNG).
 */
import appMarkSvg from './app-mark.svg?raw';

export const APP_MARK_SVG = appMarkSvg;

export function AppMark({ size = 32 }: { size?: number }) {
  return (
    <span
      className="app-mark"
      style={{ inlineSize: size, blockSize: size }}
      aria-hidden="true"
      // Static, trusted markup defined above (no user input).
      dangerouslySetInnerHTML={{ __html: APP_MARK_SVG }}
    />
  );
}
