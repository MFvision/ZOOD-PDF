/**
 * Original ZOOD PDF icon set: 24-unit grid, 1.75 stroke, round joins. Drawn for this project; no
 * third-party artwork.
 */
import type { SVGProps } from 'react';

const P = (d: string) => <path d={d} />;

export const ICONS = {
  home: <>{P('M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z')}</>,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      {P('M12 7.5V12l3 2')}
    </>
  ),
  star: <>{P('m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z')}</>,
  tag: (
    <>
      {P('M4 12.2V5a1 1 0 0 1 1-1h7.2L20 11.8a1.4 1.4 0 0 1 0 2L13.8 20a1.4 1.4 0 0 1-2 0z')}
      <circle cx="8.5" cy="8.5" r="1.3" />
    </>
  ),
  cloud: <>{P('M7.5 18.5h9.5a3.5 3.5 0 0 0 .6-6.95A5.5 5.5 0 0 0 7 10.1a4.2 4.2 0 0 0 .5 8.4z')}</>,
  plus: <>{P('M12 5v14M5 12h14')}</>,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      {P('m20 20-4.5-4.5')}
    </>
  ),
  open: <>{P('M3.5 7.5v10a1.5 1.5 0 0 0 1.5 1.5h13.2a1.5 1.5 0 0 0 1.45-1.1L21 11.5H7.3a1.5 1.5 0 0 0-1.45 1.1L3.5 19M3.5 7.5V6A1.5 1.5 0 0 1 5 4.5h4l2 2h6.5A1.5 1.5 0 0 1 19 8v3.5')}</>,
  create: (
    <>
      {P('M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z')}
      {P('M13.5 3.5v5h5M12 11.5v6M9 14.5h6')}
    </>
  ),
  doc: (
    <>
      {P('M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z')}
      {P('M13.5 3.5v5h5M9 13h6M9 16.5h4')}
    </>
  ),
  edit: <>{P('M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14.5 7.5l3 3')}</>,
  convert: <>{P('M4 8h13l-3.5-3.5M20 16H7l3.5 3.5')}</>,
  sparkle: (
    <>
      {P('M11 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5z')}
      {P('M18 15.5c.3 1.6 1 2.3 2.5 2.5-1.5.2-2.2.9-2.5 2.5-.3-1.6-1-2.3-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z')}
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
    </>
  ),
  comment: <>{P('M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5v-3.5h-1A1.5 1.5 0 0 1 4 15V6.5A1.5 1.5 0 0 1 5.5 5zM8 9.5h8M8 12.5h5')}</>,
  sign: <>{P('M3.5 17.5c2-3.5 4-9 6-9 1.8 0-1.2 8 .8 8 1.3 0 2.2-3 3.4-3 1 0 .8 2.2 2 2.2.9 0 1.6-.9 2.3-1.7M3.5 20.5h17')}</>,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      {P('M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.5v2')}
    </>
  ),
  redact: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <rect x="7" y="9" width="10" height="2.4" rx=".6" fill="currentColor" />
      {P('M7 14.5h6')}
    </>
  ),
  export: <>{P('M12 14V4M8 7.5 12 4l4 3.5M6 11H5.5A1.5 1.5 0 0 0 4 12.5v6A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H18')}</>,
  compare: (
    <>
      <rect x="3.5" y="5" width="7.5" height="14" rx="1.5" />
      <rect x="13" y="5" width="7.5" height="14" rx="1.5" />
      {P('M6 9h2.5M6 12h2.5M15.5 9h2.5M15.5 12h2.5')}
    </>
  ),
  scan: <>{P('M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5M4 12h16')}</>,
  combine: (
    <>
      <rect x="4" y="3.5" width="10" height="12.5" rx="1.5" />
      {P('M10 8v12.5h10V8zM17.5 14.5h-5M15 12v5')}
    </>
  ),
  compress: <>{P('M12 3.5v6M9 6.5l3 3 3-3M12 20.5v-6M9 17.5l3-3 3 3M5 12h14')}</>,
  form: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="7" y="7.5" width="10" height="3" rx=".8" />
      {P('M7 14h3M7 17h3')}
      <rect x="12.5" y="13.2" width="4.5" height="4.5" rx=".8" />
    </>
  ),
  stamp: <>{P('M9.5 12.5 9 8.5a3 3 0 1 1 6 0l-.5 4M5 16a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 19 16v1.5H5zM6.5 20.5h11')}</>,
  certificate: (
    <>
      <rect x="3.5" y="4.5" width="17" height="12" rx="1.5" />
      <circle cx="15.5" cy="11" r="2.4" />
      {P('M14 13v6.5l1.5-1 1.5 1V13M7 8.5h5M7 11.5h3')}
    </>
  ),
  badge: <>{P('M12 3.5 14 5.4l2.7-.3.6 2.7 2.4 1.3-1.1 2.5 1.1 2.5-2.4 1.3-.6 2.7-2.7-.3L12 20.5l-2-1.9-2.7.3-.6-2.7-2.4-1.3 1.1-2.5-1.1-2.5 2.4-1.3.6-2.7 2.7.3zM9 12l2 2 4-4')}</>,
  accessibility: (
    <>
      <circle cx="12" cy="5.5" r="1.8" />
      {P('M5 9l7 1.5L19 9M12 10.5V14l-3 6M12 14l3 6')}
    </>
  ),
  batch: <>{P('M4 8l8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4')}</>,
  library: <>{P('M5 4.5h3v15H5zM10 4.5h3v15h-3zM15 5.2l2.8-.7 3.3 14.5-2.9.7z')}</>,
  organize: (
    <>
      <rect x="4" y="4" width="7" height="9" rx="1.2" />
      <rect x="13" y="4" width="7" height="9" rx="1.2" />
      {P('M4 17h16M4 20h10')}
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      {P('M9.5 4.5v15M5.8 8h1.6M5.8 11h1.6')}
    </>
  ),
  inspector: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      {P('M14.5 4.5v15M16.6 8h1.6M16.6 11h1.6')}
    </>
  ),
  chevronStart: <>{P('M14.5 6 8.5 12l6 6')}</>,
  chevronEnd: <>{P('m9.5 6 6 6-6 6')}</>,
  chevronDown: <>{P('m6 9.5 6 6 6-6')}</>,
  chevronUp: <>{P('m6 14.5 6-6 6 6')}</>,
  zoomIn: <>{P('M12 6v12M6 12h12')}</>,
  zoomOut: <>{P('M6 12h12')}</>,
  close: <>{P('m6.5 6.5 11 11M17.5 6.5l-11 11')}</>,
  ellipsis: (
    <>
      <circle cx="6.5" cy="12" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      <circle cx="17.5" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      {P('M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6')}
    </>
  ),
  save: <>{P('M12 4v10M8 10.5l4 4 4-4M5 16.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5')}</>,
  check: <>{P('m5 12.5 4.5 4.5L19 7.5')}</>,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      {P('M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z')}
    </>
  ),
  install: <>{P('M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 17.5v1A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-1')}</>,
  trash: <>{P('M5 7h14M10 4h4M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7M10.5 11v5.5M13.5 11v5.5')}</>,
  send: <>{P('M12 19V5M6.5 10.5 12 5l5.5 5.5')}</>,
  menu: <>{P('M4.5 7h15M4.5 12h15M4.5 17h15')}</>,
  pages: (
    <>
      <rect x="7" y="3.5" width="12" height="15" rx="1.5" />
      {P('M5 7v12a1.5 1.5 0 0 0 1.5 1.5H15')}
    </>
  ),
  // Export formats and Compare.
  table: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      {P('M4 10h16M4 14.5h16M10 5v14')}
    </>
  ),
  slides: (
    <>
      <rect x="3.5" y="5" width="17" height="11" rx="1.5" />
      {P('M12 16v3.5M8.5 19.5h7M7.5 9h6M7.5 12h4')}
    </>
  ),
  markdown: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      {P('M6.5 15V9l2.5 3 2.5-3v6M15.5 9v6M13.5 13l2 2 2-2')}
    </>
  ),
  text: <>{P('M5 6.5h14M5 10.5h14M5 14.5h14M5 18.5h9')}</>,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      {P('m4 17 5-4.5 3.5 3 3-2.5 4.5 4')}
    </>
  ),
  swap: <>{P('M7 7.5h11M15 4.5l3 3-3 3M17 16.5H6M9 13.5l-3 3 3 3')}</>,
  // ---- Organize / Combine / Compress ----
  rotateLeft: <>{P('M5 9.5A7.5 7.5 0 1 1 5.6 15M5 4.5v5h5')}</>,
  rotateRight: <>{P('M19 9.5A7.5 7.5 0 1 0 18.4 15M19 4.5v5h-5')}</>,
  pageAdd: (
    <>
      {P('M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z')}
      {P('M13.5 3.5v5h5M12 11.5v6M9 14.5h6')}
    </>
  ),
  pageDelete: (
    <>
      {P('M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z')}
      {P('M13.5 3.5v5h5M9.5 12.5l5 5M14.5 12.5l-5 5')}
    </>
  ),
  replace: <>{P('M4 8.5h11.5L12 5M20 15.5H8.5L12 19')}</>,
  crop: <>{P('M7 3v13.5A.5.5 0 0 0 7.5 17H21M3 7h13.5a.5.5 0 0 1 .5.5V21')}</>,
  trim: (
    <>
      <rect x="7.5" y="7.5" width="9" height="9" rx="1" />
      {P('M3.5 3.5h3M3.5 3.5v3M20.5 3.5h-3M20.5 3.5v3M3.5 20.5h3M3.5 20.5v-3M20.5 20.5h-3M20.5 20.5v-3')}
    </>
  ),
  split: (
    <>
      <rect x="4" y="3.5" width="7" height="17" rx="1.5" />
      <rect x="13" y="3.5" width="7" height="17" rx="1.5" />
    </>
  ),
  picture: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      {P('m4 17 5-4.5 4 3.5 2.5-2 4.5 4')}
    </>
  ),
  undo: <>{P('M9 5 4.5 9.5 9 14M5 9.5h9a5.5 5.5 0 0 1 0 11h-3')}</>,
  redo: <>{P('M15 5l4.5 4.5L15 14M19 9.5h-9a5.5 5.5 0 0 0 0 11h3')}</>,
  grip: (
    <>
      <circle cx="9" cy="7" r="1" />
      <circle cx="15" cy="7" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="17" r="1" />
      <circle cx="15" cy="17" r="1" />
    </>
  ),
  arrowUp: <>{P('M12 19V5M6 11l6-6 6 6')}</>,
  arrowDown: <>{P('M12 5v14M6 13l6 6 6-6')}</>,
  // Create PDF: reorder the file list.
  moveUp: <>{P('m6.5 14.5 5.5-5.5 5.5 5.5')}</>,
  moveDown: <>{P('m6.5 9.5 5.5 5.5 5.5-5.5')}</>,
  // Edit tool.
  cursor: <>{P('M6 4.5 18 12l-5.2 1.3 3 5.4-2.2 1.2-3-5.4L6.5 18z')}</>,
  textAdd: <>{P('M5 6.5V5h11v1.5M10.5 5v13M8.5 18h4M17 13v6M14 16h6')}</>,
  link: <>{P('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1')}</>,
} as const;

export type IconName = keyof typeof ICONS;

/** Icons that point along the reading direction and must mirror in RTL. */
const DIRECTIONAL = new Set<IconName>(['chevronStart', 'chevronEnd', 'convert', 'comment', 'undo', 'redo']);

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={DIRECTIONAL.has(name) ? 'icon icon-directional' : 'icon'}
      {...rest}
    >
      {ICONS[name]}
    </svg>
  );
}
