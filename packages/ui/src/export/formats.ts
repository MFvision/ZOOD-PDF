import type { TKey } from '../i18n/messages';
import type { FileKind } from '../state/saveFile';

export type ExportFormat = 'docx' | 'txt' | 'md' | 'html' | 'png';

export interface ExportFormatInfo {
  id: ExportFormat;
  labelKey: TKey;
  /** What the format keeps and what it loses, said plainly beside it. */
  noteKey: TKey;
}

/** In the order the panel offers them. */
export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  { id: 'docx', labelKey: 'export.word', noteKey: 'export.wordNote' },
  { id: 'txt', labelKey: 'export.text', noteKey: 'export.textNote' },
  { id: 'md', labelKey: 'export.markdown', noteKey: 'export.markdownNote' },
  { id: 'html', labelKey: 'export.html', noteKey: 'export.htmlNote' },
  { id: 'png', labelKey: 'export.images', noteKey: 'export.imagesNote' },
];

/** Page image resolutions, in dots per inch: screen, everyday, print. */
export const RESOLUTIONS = [72, 150, 300] as const;
export const DEFAULT_RESOLUTION = 150;

/** How each export is handed over: its media type, and its kind in the desktop save panel. */
export const FILE_KINDS: Record<ExportFormat | 'zip', FileKind> = {
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filter: { name: 'Word', extensions: ['docx'] },
  },
  txt: { mime: 'text/plain;charset=utf-8', filter: { name: 'Text', extensions: ['txt'] } },
  md: { mime: 'text/markdown;charset=utf-8', filter: { name: 'Markdown', extensions: ['md'] } },
  html: { mime: 'text/html;charset=utf-8', filter: { name: 'HTML', extensions: ['html'] } },
  png: { mime: 'image/png', filter: { name: 'PNG', extensions: ['png'] } },
  zip: { mime: 'application/zip', filter: { name: 'ZIP', extensions: ['zip'] } },
};
