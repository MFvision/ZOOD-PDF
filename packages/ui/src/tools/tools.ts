import {
  ClipboardList,
  Combine,
  EyeOff,
  FileOutput,
  GitCompare,
  LayoutGrid,
  MessageSquare,
  Pencil,
  PenLine,
  ScanText,
  Shield,
  Shrink,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TKey } from '../i18n/messages';

export type ToolId =
  | 'edit'
  | 'organize'
  | 'comment'
  | 'fillSign'
  | 'protect'
  | 'redact'
  | 'export'
  | 'compare'
  | 'ocr'
  | 'combine'
  | 'compress'
  | 'prepareForm'
  | 'ai';

export interface ToolDefinition {
  id: ToolId;
  labelKey: TKey;
  icon: LucideIcon;
  /** Phase 1 implements none of the tools; each opens a "coming later" panel. */
  implemented: boolean;
}

export const TOOLS: readonly ToolDefinition[] = [
  { id: 'edit', labelKey: 'tool.edit', icon: Pencil, implemented: false },
  { id: 'organize', labelKey: 'tool.organize', icon: LayoutGrid, implemented: false },
  { id: 'comment', labelKey: 'tool.comment', icon: MessageSquare, implemented: false },
  { id: 'fillSign', labelKey: 'tool.fillSign', icon: PenLine, implemented: false },
  { id: 'protect', labelKey: 'tool.protect', icon: Shield, implemented: false },
  { id: 'redact', labelKey: 'tool.redact', icon: EyeOff, implemented: false },
  { id: 'export', labelKey: 'tool.export', icon: FileOutput, implemented: false },
  { id: 'compare', labelKey: 'tool.compare', icon: GitCompare, implemented: false },
  { id: 'ocr', labelKey: 'tool.ocr', icon: ScanText, implemented: false },
  { id: 'combine', labelKey: 'tool.combine', icon: Combine, implemented: false },
  { id: 'compress', labelKey: 'tool.compress', icon: Shrink, implemented: false },
  { id: 'prepareForm', labelKey: 'tool.prepareForm', icon: ClipboardList, implemented: false },
  { id: 'ai', labelKey: 'tool.ai', icon: Sparkles, implemented: false },
];

export function findTool(id: ToolId): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.id === id);
}
