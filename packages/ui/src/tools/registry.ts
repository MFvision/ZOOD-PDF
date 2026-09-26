/**
 * The 20 tools of ZOOD PDF. A tool is shown ONLY when `status: 'ready'` (it works end to end on that
 * platform). No "coming soon", no dead buttons: agents implementing a tool flip it to ready together
 * with its Playwright spec.
 */
import type { MessageKey } from '../i18n';
import type { IconName } from '../app/icons';
import { openToolPanel } from './panels';

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
  /** Core-backed tools: set by the agent implementing the tool. `docId`: the document to act on. */
  core?: { open: (docId?: string) => void | Promise<void> };
  /** Tools whose UI is a side panel (opened through tools/panels; one panel at a time). */
  panel?: string;
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
  // Edit: core-backed surface over the viewer (warraq-edit), see app/EditPanel.tsx.
  tool('edit', 'edit', 'blue', { status: 'ready', core: { open: (docId) => openToolPanel('edit', docId) } }),
  // Organize / Combine / Compress: engine-backed panels (see tools/panels.ts).
  tool('organize', 'organize', 'indigo', { status: 'ready', core: { open: (docId) => openToolPanel('organize', docId) } }),
  tool('comment', 'comment', 'yellow', { status: 'ready', viewer: { commands: ['mode:annotate'] } }),
  tool('fill-sign', 'sign', 'purple', { status: 'ready', viewer: { commands: ['mode:insert'] } }),
  // Redact: EmbedPDF draws the marks (mode:redact) and the engine applies them from the side panel.
  // Protect: engine only (AES-256), in the side panel.
  tool('protect', 'lock', 'graphite', { status: 'ready', panel: 'protect', core: { open: (docId) => openToolPanel('protect', docId) } }),
  tool('redact', 'redact', 'red', {
    status: 'ready',
    viewer: { commands: ['mode:redact'] },
    panel: 'redact',
    core: { open: (docId) => openToolPanel('redact', docId) },
  }),
  // Export and Compare: core-backed panels (warraq-office), see tools/panels.ts.
  tool('export', 'export', 'green', { status: 'ready', core: { open: (docId) => openToolPanel('export', docId) } }),
  // Create PDF: warraq-create (own layout engine) via `create.fromFiles`; sheet in tools/create.
  tool('create', 'create', 'blue', { needsDocument: false, status: 'ready', core: { open: () => openToolPanel('create') } }),
  tool('compare', 'compare', 'teal', { status: 'ready', core: { open: (docId) => openToolPanel('compare', docId) } }),
  tool('scan', 'scan', 'cyan', { needsDocument: false }),
  tool('combine', 'combine', 'orange', { status: 'ready', needsDocument: false, core: { open: (docId) => openToolPanel('combine', docId) } }),
  tool('compress', 'compress', 'mint', { status: 'ready', core: { open: (docId) => openToolPanel('compress', docId) } }),
  tool('prepare-form', 'form', 'pink', { status: 'ready', viewer: { commands: ['mode:form'] } }),
  tool('ai', 'sparkle', 'purple'),
  tool('page-marks', 'stamp', 'orange'),
  tool('digital-signature', 'certificate', 'indigo'),
  tool('standards', 'badge', 'teal', { status: 'ready', panel: 'standards', core: { open: (docId) => openToolPanel('standards', docId) } }),
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
