import type { TKey } from '../i18n/messages';
import type { ToolId } from './tools';

/**
 * The tools under eight headings, as the home screen's sidebar shows them:
 * each heading opens a short menu of its tools (or, with one tool, opens
 * it). Every tool is under exactly one heading (`groups.test.ts`).
 */
export interface ToolGroup {
  id: string;
  label: TKey;
  tools: readonly ToolId[];
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: 'edit', label: 'group.edit', tools: ['edit', 'pageMarks', 'prepareForm'] },
  { id: 'annotate', label: 'group.annotate', tools: ['comment', 'fillSign', 'compare'] },
  { id: 'organize', label: 'group.organize', tools: ['organize', 'combine', 'batch'] },
  { id: 'convert', label: 'group.convert', tools: ['export', 'create', 'standards'] },
  { id: 'compress', label: 'group.compress', tools: ['compress'] },
  { id: 'ocr', label: 'group.ocr', tools: ['ocr', 'accessibility'] },
  { id: 'protect', label: 'group.protect', tools: ['protect', 'redact', 'certificates'] },
  { id: 'ai', label: 'group.ai', tools: ['ai', 'library'] },
];
