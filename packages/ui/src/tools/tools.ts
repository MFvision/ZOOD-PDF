import {
  ArrowUpRight,
  CheckSquare,
  CircleDot,
  ClipboardList,
  Combine,
  Eraser,
  FileSignature,
  Highlighter,
  ListChecks,
  Link,
  LockKeyhole,
  MessageSquarePlus,
  PenTool,
  RectangleHorizontal,
  ScanLine,
  SquareDashedMousePointer,
  Stamp,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline,
  ChevronDownSquare,
  EyeOff,
  FileOutput,
  GitCompare,
  Layers,
  LayoutGrid,
  MessageSquare,
  Pencil,
  PenLine,
  ScanText,
  Shield,
  Shrink,
  Sparkles,
  FileBadge,
  FilePlus2,
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
  | 'create'
  | 'compress'
  | 'prepareForm'
  | 'ai'
  | 'pageMarks'
  | 'certificates';

/**
 * One control in a tool's panel: an EmbedPDF command (ADR-0007), run through
 * its commands plugin. The ids are the ones the viewer registers — listed at
 * runtime, not guessed — so a button here is never a dead one.
 */
export interface ToolAction {
  command: string;
  labelKey: TKey;
  icon: LucideIcon;
}

export interface ToolDefinition {
  id: ToolId;
  labelKey: TKey;
  icon: LucideIcon;
  /** Unimplemented tools open a "coming later" panel instead of a real one. */
  implemented: boolean;
  /** The EmbedPDF mode the tool switches the view to when it is chosen. */
  mode?: string;
  /** What the tool's panel offers, each one a working command. */
  actions?: readonly ToolAction[];
}

export const TOOLS: readonly ToolDefinition[] = [
  { id: 'edit', labelKey: 'tool.edit', icon: Pencil, implemented: true },
  // Warraq's own engine: EmbedPDF 2.15 cannot move or rotate pages.
  { id: 'organize', labelKey: 'tool.organize', icon: LayoutGrid, implemented: true },
  {
    id: 'comment',
    labelKey: 'tool.comment',
    icon: MessageSquare,
    implemented: true,
    mode: 'mode:annotate',
    actions: [
      { command: 'annotation:add-highlight', labelKey: 'action.highlight', icon: Highlighter },
      { command: 'annotation:add-underline', labelKey: 'action.underline', icon: Underline },
      { command: 'annotation:add-strikeout', labelKey: 'action.strikeout', icon: Strikethrough },
      { command: 'annotation:add-comment', labelKey: 'action.note', icon: MessageSquarePlus },
      { command: 'annotation:add-text', labelKey: 'action.textBox', icon: Type },
      { command: 'annotation:add-ink', labelKey: 'action.draw', icon: PenTool },
      { command: 'annotation:add-rectangle', labelKey: 'action.rectangle', icon: RectangleHorizontal },
      { command: 'annotation:add-arrow', labelKey: 'action.arrow', icon: ArrowUpRight },
      { command: 'annotation:add-link', labelKey: 'action.link', icon: Link },
    ],
  },
  {
    id: 'fillSign',
    labelKey: 'tool.fillSign',
    icon: PenLine,
    implemented: true,
    mode: 'mode:form',
    actions: [
      { command: 'form:toggle-fill-mode', labelKey: 'action.fillForm', icon: TextCursorInput },
      { command: 'signature:create', labelKey: 'action.createSignature', icon: FileSignature },
      { command: 'insert:add-signature', labelKey: 'action.placeSignature', icon: PenLine },
      { command: 'insert:add-rubber-stamp', labelKey: 'action.stamp', icon: Stamp },
    ],
  },
  {
    id: 'protect',
    labelKey: 'tool.protect',
    icon: Shield,
    implemented: true,
    actions: [{ command: 'document:protect', labelKey: 'action.setPassword', icon: LockKeyhole }],
  },
  {
    id: 'redact',
    labelKey: 'tool.redact',
    icon: EyeOff,
    implemented: true,
    mode: 'mode:redact',
    actions: [
      { command: 'redaction:redact-text', labelKey: 'action.redactText', icon: ScanLine },
      { command: 'redaction:redact-area', labelKey: 'action.redactArea', icon: SquareDashedMousePointer },
      { command: 'redaction:apply-all', labelKey: 'action.applyRedactions', icon: Eraser },
      { command: 'redaction:clear-all', labelKey: 'action.clearRedactions', icon: EyeOff },
    ],
  },
  // Warraq's own engine: PDFium reads Arabic in visual order, the core in reading order.
  { id: 'export', labelKey: 'tool.export', icon: FileOutput, implemented: true },
  // Warraq's own reading (`extract_text`, logical order), diffed word by word.
  { id: 'compare', labelKey: 'tool.compare', icon: GitCompare, implemented: true },
  // Tesseract in the page, a text layer by Warraq's core (`ocr.add_text_layer`).
  { id: 'ocr', labelKey: 'tool.ocr', icon: ScanText, implemented: true },
  // Warraq's core (`pages.combine`): PDFium's importer breaks form fields (ADR-0008).
  { id: 'combine', labelKey: 'tool.combine', icon: Combine, implemented: true },
  // Warraq's own: Word, Excel, PowerPoint, web pages, Markdown, text and pictures read in the page, laid out by the core (`create.*`).
  { id: 'create', labelKey: 'tool.create', icon: FilePlus2, implemented: true },
  // Warraq's core (`compress.file`): a smaller copy, written from scratch.
  { id: 'compress', labelKey: 'tool.compress', icon: Shrink, implemented: true },
  {
    id: 'prepareForm',
    labelKey: 'tool.prepareForm',
    icon: ClipboardList,
    implemented: true,
    mode: 'mode:form',
    actions: [
      { command: 'form:add-textfield', labelKey: 'action.textField', icon: TextCursorInput },
      { command: 'form:add-checkbox', labelKey: 'action.checkbox', icon: CheckSquare },
      { command: 'form:add-radio', labelKey: 'action.radio', icon: CircleDot },
      { command: 'form:add-select', labelKey: 'action.dropdown', icon: ChevronDownSquare },
      { command: 'form:add-listbox', labelKey: 'action.listbox', icon: ListChecks },
    ],
  },
  // Warraq's own: the person's Anthropic key or a local model, only on Send (`ai/AiPanel.tsx`).
  { id: 'ai', labelKey: 'tool.ai', icon: Sparkles, implemented: true },
  // Warraq's core (`marks.*`): watermarks, headers and footers, page and Bates numbers, shaped Arabic.
  { id: 'pageMarks', labelKey: 'tool.pageMarks', icon: Layers, implemented: true },
  // Warraq's own: PAdES signatures and their verification (`warraq-sign`, `signatures/`).
  { id: 'certificates', labelKey: 'tool.certificates', icon: FileBadge, implemented: true },
];

export function findTool(id: ToolId): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.id === id);
}
