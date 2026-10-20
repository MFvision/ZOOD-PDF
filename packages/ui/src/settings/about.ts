import notices from '../../../../THIRD-PARTY-NOTICES.md?raw';
import ui from '../../package.json';
import { isTauriHost, openExternalUrl } from '../core/host-tauri';

/**
 * Who makes ZOOD PDF and how to reach them, for Settings › About. One place,
 * so the About page, the support e-mail and the website never disagree.
 * A field left empty is not shown.
 */
export const ABOUT = {
  version: ui.version,
  builder: { en: 'Muhammad Alghammas', ar: 'محمد الغماس' },
  company: { en: 'AVA AI', ar: 'AVA AI' },
  email: 'app@zood.sa',
  phone: '920000077',
  copyright: 'ZOOD',
  licence: 'Apache-2.0',
} as const;

export interface Notice {
  component: string;
  licence: string;
}

/** The components THIRD-PARTY-NOTICES.md lists, each with its licence, as plain text. */
export function openSourceNotices(text: string = notices): Notice[] {
  const plain = (cell: string) =>
    cell
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return text
    .split('\n')
    .filter((line) => line.startsWith('| ') && !/^\|\s*(Component|---)/.test(line))
    .map((line) => line.split('|').slice(1, -1))
    .filter((cells) => cells.length >= 2)
    .map(([component, licence]) => ({ component: plain(component!), licence: plain(licence!) }));
}

/** A support e-mail, with what support needs to know already in it. */
export function supportMail(appName: string, platform: string = navigator.userAgent): string {
  const subject = `${appName} ${ABOUT.version}`;
  const body = `\n\n—\n${appName} ${ABOUT.version}\n${platform}`;
  return `mailto:${ABOUT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function openMail(url: string): void {
  if (isTauriHost()) void openExternalUrl(url).catch(() => undefined);
  else globalThis.location.href = url;
}
