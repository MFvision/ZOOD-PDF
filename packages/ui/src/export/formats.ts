import type { TKey } from '../i18n/messages';
import type { FileKind } from '../state/saveFile';

export type ExportFormat = 'docx' | 'xlsx' | 'pptx' | 'txt' | 'md' | 'html' | 'png';

export interface ExportFormatInfo {
  id: ExportFormat;
  labelKey: TKey;
  /** What the format keeps and what it loses, said plainly beside it. */
  noteKey: TKey;
}

/** In the order the panel offers them. */
export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  { id: 'docx', labelKey: 'export.word', noteKey: 'export.wordNote' },
  { id: 'xlsx', labelKey: 'export.excel', noteKey: 'export.excelNote' },
  { id: 'pptx', labelKey: 'export.powerpoint', noteKey: 'export.powerpointNote' },
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
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filter: { name: 'Excel', extensions: ['xlsx'] },
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    filter: { name: 'PowerPoint', extensions: ['pptx'] },
  },
  txt: { mime: 'text/plain;charset=utf-8', filter: { name: 'Text', extensions: ['txt'] } },
  md: { mime: 'text/markdown;charset=utf-8', filter: { name: 'Markdown', extensions: ['md'] } },
  html: { mime: 'text/html;charset=utf-8', filter: { name: 'HTML', extensions: ['html'] } },
  png: { mime: 'image/png', filter: { name: 'PNG', extensions: ['png'] } },
  zip: { mime: 'application/zip', filter: { name: 'ZIP', extensions: ['zip'] } },
};
