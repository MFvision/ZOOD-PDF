/**
 * The 20 tools of ZOOD PDF. A tool is shown ONLY when `status: 'ready'` (it works end to end on that
 * platform). No "coming soon", no dead buttons: agents implementing a tool flip it to ready together
 * with its Playwright spec.
 */
import type { MessageKey } from '../i18n';
import type { IconName } from '../app/icons';
import { openScan } from '../ocr/store';

export type ToolId =
  | 'edit'
  | 'organize'
  | 'comment'
  | 'fill-sign'
  | 'protect'
  | 'redact'
  | 'export'
  | 'create'
  | 'compare'
  | 'scan'
  | 'combine'
  | 'compress'
  | 'prepare-form'
  | 'ai'
  | 'page-marks'
  | 'digital-signature'
  | 'standards'
  | 'accessibility'
  | 'batch'
  | 'library';

export type Platform = 'web' | 'desktop' | 'extension' | 'ios';

/** Pastel tile colours; each maps to `--tile-<name>` tokens (light and dark). */
export type TileColour = 'blue' | 'indigo' | 'purple' | 'pink' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'mint' | 'cyan' | 'graphite';

export interface ToolDef {
  id: ToolId;
  nameKey: MessageKey;
  descKey: MessageKey;
  icon: IconName;
  tile: TileColour;
  platforms: Platform[];
  status: 'ready' | 'hidden';
  /** Viewer-backed tools: EmbedPDF commands executed when the tool is picked. */
  viewer?: { commands: string[] };
  /** Core-backed tools: set by the agent implementing the tool. */
  core?: { open: () => void | Promise<void> };
  /** Needs an open document. */
  needsDocument: boolean;
}

const ALL: Platform[] = ['web', 'desktop', 'extension', 'ios'];

function tool(
  id: ToolId,
  icon: IconName,
  tile: TileColour,
  extra: Partial<Omit<ToolDef, 'id' | 'icon' | 'tile' | 'nameKey' | 'descKey'>> = {},
): ToolDef {
  return {
    id,
    icon,
    tile,
    nameKey: `tool.${id}.name` as MessageKey,
    descKey: `tool.${id}.desc` as MessageKey,
    platforms: ALL,
    status: 'hidden',
    needsDocument: true,
    ...extra,
  };
}

export const TOOLS: readonly ToolDef[] = [
  tool('edit', 'edit', 'blue'),
  tool('organize', 'organize', 'indigo'),
  tool('comment', 'comment', 'yellow', { status: 'ready', viewer: { commands: ['mode:annotate'] } }),
  tool('fill-sign', 'sign', 'purple', { status: 'ready', viewer: { commands: ['mode:insert'] } }),
  tool('protect', 'lock', 'graphite', { status: 'ready', viewer: { commands: ['document:protect'] } }),
  tool('redact', 'redact', 'red', { status: 'ready', viewer: { commands: ['mode:redact'] } }),
  tool('export', 'export', 'green'),
  tool('create', 'create', 'blue', { needsDocument: false }),
  tool('compare', 'compare', 'teal'),
  // Scan & OCR: its sheet offers "Make searchable" for the open PDF and "Scan pages" from images.
  tool('scan', 'scan', 'cyan', { status: 'ready', needsDocument: false, core: { open: () => openScan() } }),
  tool('combine', 'combine', 'orange'),
  tool('compress', 'compress', 'mint'),
  tool('prepare-form', 'form', 'pink', { status: 'ready', viewer: { commands: ['mode:form'] } }),
  tool('ai', 'sparkle', 'purple'),
  tool('page-marks', 'stamp', 'orange'),
  tool('digital-signature', 'certificate', 'indigo'),
  tool('standards', 'badge', 'teal'),
  tool('accessibility', 'accessibility', 'blue'),
  tool('batch', 'batch', 'graphite', { needsDocument: false }),
  tool('library', 'library', 'green', { needsDocument: false }),
];

export function toolById(id: ToolId): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}

export function isToolReady(id: ToolId, platform: Platform): boolean {
  const t = toolById(id);
  return !!t && t.status === 'ready' && t.platforms.includes(platform);
}

export function readyTools(platform: Platform): ToolDef[] {
  return TOOLS.filter((t) => t.status === 'ready' && t.platforms.includes(platform));
}
