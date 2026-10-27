import type { PutAwayPlaces, PutAwayRule } from '../core/host-tauri';
import type { TKey } from '../i18n/messages';

/**
 * Put away's first rules (`src-tauri/src/putaway.rs`), after "Stow": the
 * person's own documents only ever go into one inbox folder, never deeper;
 * screenshots, fonts, design files, books, pictures, videos, music and
 * archives each into a folder of their own. Installers and anything else
 * stay where they are. Every rule can be changed or removed.
 */

/** Joins a folder and a name with the folder's own separator. */
export function joinPath(folder: string, name: string): string {
  const sep = folder.includes('\\') ? '\\' : '/';
  return folder.endsWith(sep) ? `${folder}${name}` : `${folder}${sep}${name}`;
}

/** The last one or two parts of a folder's path, for its card. */
export function shortPlace(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(' › ');
}

const RULES: { icon: string; name: TKey; exts?: string[]; words?: string[]; place: keyof PutAwayPlaces; folder?: TKey }[] = [
  {
    icon: 'inbox',
    name: 'putAway.rule.inbox',
    exts: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'pages', 'xls', 'xlsx', 'ods', 'csv', 'numbers', 'ppt', 'pptx', 'odp', 'key'],
    place: 'documents',
    folder: 'putAway.folder.inbox',
  },
  { icon: 'camera', name: 'putAway.rule.screenshots', words: ['screenshot', 'screen shot', 'لقطة شاشة', 'لقطة الشاشة'], place: 'pictures', folder: 'putAway.folder.screenshots' },
  { icon: 'fonts', name: 'putAway.rule.fonts', exts: ['otf', 'ttf', 'woff', 'woff2'], place: 'documents', folder: 'putAway.folder.fonts' },
  { icon: 'design', name: 'putAway.rule.design', exts: ['psd', 'ai', 'sketch', 'fig', 'xd', 'indd', 'afdesign', 'afphoto'], place: 'documents', folder: 'putAway.folder.design' },
  { icon: 'books', name: 'putAway.rule.books', exts: ['epub', 'mobi', 'azw', 'azw3'], place: 'documents', folder: 'putAway.folder.books' },
  { icon: 'pictures', name: 'putAway.rule.pictures', exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff'], place: 'pictures' },
  { icon: 'videos', name: 'putAway.rule.videos', exts: ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm'], place: 'videos' },
  { icon: 'music', name: 'putAway.rule.music', exts: ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'], place: 'music' },
  { icon: 'archives', name: 'putAway.rule.archives', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'], place: 'documents', folder: 'putAway.folder.archives' },
];

export function defaultRules(places: PutAwayPlaces, t: (key: TKey) => string): PutAwayRule[] {
  return RULES.flatMap((rule) => {
    const base = places[rule.place];
    if (!base) return [];
    return [
      {
        name: t(rule.name),
        icon: rule.icon,
        exts: rule.exts ?? [],
        words: rule.words ?? [],
        to: rule.folder ? joinPath(base, t(rule.folder)) : base,
        bin: false,
        binDays: 2,
      },
    ];
  });
}

/** "otf, .TTF  woff" as a rule keeps it: ["otf", "ttf", "woff"]. */
export function typesOf(text: string): string[] {
  return text
    .split(/[\s,،;]+/)
    .map((part) => part.trim().replace(/^\./, '').toLowerCase())
    .filter((part) => /^[\p{L}\p{N}]{1,12}$/u.test(part));
}

/** "screenshot, لقطة شاشة" as a rule keeps it. */
export function wordsOf(text: string): string[] {
  return text
    .split(/[,،;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}
