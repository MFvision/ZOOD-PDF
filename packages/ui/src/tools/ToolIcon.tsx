import type { CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import type { ToolDefinition, ToolId } from './tools';

/**
 * Each tool's colour, from the system palette, so the tools can be told apart
 * at a glance in the gallery, the tools list and the home screen — the way
 * the system's settings give each pane a coloured tile. A tool added later
 * without a colour gets the accent.
 */
const TOOL_COLORS: Partial<Record<ToolId, string>> = {
  edit: '#007aff',
  organize: '#5856d6',
  comment: '#ff9500',
  fillSign: '#af52de',
  protect: '#34c759',
  redact: '#636366',
  export: '#30b0c7',
  compare: '#ff2d55',
  ocr: '#32ade6',
  combine: '#00c7be',
  compress: '#a2845e',
  prepareForm: '#5ac8fa',
  ai: '#bf5af2',
  certificates: '#c69300',
  pageMarks: '#ff3b30',
  standards: '#248a3d',
  accessibility: '#0071a4',
};

export function toolColor(id: ToolId): string {
  return TOOL_COLORS[id] ?? 'var(--accent)';
}

/** The tool's glyph, white on its coloured rounded square. */
export function ToolIcon({ tool, size = 'regular' }: { tool: ToolDefinition; size?: 'small' | 'regular' | 'large' }) {
  const glyph = size === 'large' ? 22 : size === 'small' ? 14 : 18;
  return (
    <span className={`tool-icon tool-icon-${size}`} style={{ '--tool-color': toolColor(tool.id) } as CSSProperties} aria-hidden="true">
      <Icon of={tool.icon} size={glyph} />
    </span>
  );
}
