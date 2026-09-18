import { Icon } from '../components/Icon';
import { CombinePanel } from '../combine/CombinePanel';
import { EditPanel } from '../edit/EditPanel';
import { ExportPanel } from '../export/ExportPanel';
import { OrganizePanel } from '../organize/OrganizePanel';
import { useT } from '../i18n/useT';
import { ComingLater } from './ComingLater';
import { EmbedToolPanel } from './EmbedToolPanel';
import type { ToolDefinition } from './tools';

export function ToolPanel({ tool }: { tool: ToolDefinition }) {
  const t = useT();
  const name = t(tool.labelKey);
  if (tool.id === 'edit') return <EditPanel />;
  if (tool.id === 'organize') return <OrganizePanel />;
  if (tool.id === 'combine') return <CombinePanel />;
  if (tool.id === 'export') return <ExportPanel />;
  if (tool.actions && tool.actions.length > 0) return <EmbedToolPanel tool={tool} />;
  return (
    <div className="tool-panel">
      <h3>
        <Icon of={tool.icon} />
        {name}
      </h3>
      <ComingLater message={t('tool.comingLater', { tool: name })} />
    </div>
  );
}
