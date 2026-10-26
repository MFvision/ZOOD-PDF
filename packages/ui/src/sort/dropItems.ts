import { Combine, Feather, FileImage, FileOutput, FileSpreadsheet, FileText, FileType, Globe, LayoutGrid, MessageCircle, Presentation, Printer, Smartphone, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TKey } from '../i18n/messages';
import type { DropItem } from '../state/settings';

/**
 * What each target of the drop zone's panel looks like wherever it sits
 * (a big tile, a small chip, a bottom pill) and in Settings, where the
 * panel is laid out by dragging: its icon, its word, and what it does.
 */

type T = (key: TKey, params?: Record<string, string | number>) => string;

const ICONS: Record<DropItem, LucideIcon> = {
  'tile:web': Globe,
  'tile:send': Feather,
  'tile:print': Printer,
  'format:jpg': FileImage,
  'format:png': FileImage,
  'format:webp': FileImage,
  'format:pdf': FileOutput,
  'format:docx': FileText,
  'format:xlsx': FileSpreadsheet,
  'format:pptx': Presentation,
  'format:txt': FileType,
  'format:merge': Combine,
  'more:ask': MessageCircle,
  'more:organize': Sparkles,
  'more:phone': Smartphone,
  'more:tools': LayoutGrid,
};

/** The letters a format goes by, on its chip. */
export const FORMAT_LETTERS: Record<string, string> = { jpg: 'JPG', png: 'PNG', webp: 'WebP', pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PPT', txt: 'TXT' };

export const dropIcon = (id: DropItem): LucideIcon => ICONS[id];

/** One or two words: "Web", "PDF", "Ask ZOOD". */
export function dropWord(id: DropItem, t: T): string {
  const [kind, name] = id.split(':') as [string, string];
  if (kind === 'tile') return t(`stow.tile.${name}` as TKey);
  if (kind === 'more') return t(`stow.more.${name}` as TKey);
  return name === 'merge' ? t('stow.mergeShort') : (FORMAT_LETTERS[name] ?? name);
}

/** What it does, in a short sentence. */
export function dropNote(id: DropItem, t: T): string {
  const [kind, name] = id.split(':') as [string, string];
  if (kind === 'tile') return t(`dropPanel.tileNote.${name}` as TKey);
  if (kind === 'more') return t(`stow.moreNote.${name}` as TKey);
  return name === 'merge' ? t('stow.merge') : t('stow.formatTo', { format: FORMAT_LETTERS[name] ?? name });
}
