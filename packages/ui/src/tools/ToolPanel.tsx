import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { ComingLater } from './ComingLater';
import type { ToolDefinition } from './tools';

export function ToolPanel({ tool }: { tool: ToolDefinition }) {
  const t = useT();
  const name = t(tool.labelKey);
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
