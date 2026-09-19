import { AccessibilityPanel } from '../accessibility/AccessibilityPanel';
import { AiPanel } from '../ai/AiPanel';
import { Icon } from '../components/Icon';
import { CombinePanel } from '../combine/CombinePanel';
import { ComparePanel } from '../compare/ComparePanel';
import { CompressPanel } from '../compress/CompressPanel';
import { OcrPanel } from '../ocr/OcrPanel';
import { EditPanel } from '../edit/EditPanel';
import { ExportPanel } from '../export/ExportPanel';
import { OrganizePanel } from '../organize/OrganizePanel';
import { PrepareFormPanel } from '../forms/PrepareFormPanel';
import { PageMarksPanel } from '../marks/PageMarksPanel';
import { RedactPanel } from '../redact/RedactPanel';
import { SignaturesPanel } from '../signatures/SignaturesPanel';
import { StandardsPanel } from '../standards/StandardsPanel';
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
  if (tool.id === 'compress') return <CompressPanel />;
  if (tool.id === 'ocr') return <OcrPanel />;
  if (tool.id === 'export') return <ExportPanel />;
  if (tool.id === 'ai') return <AiPanel />;
  if (tool.id === 'compare') return <ComparePanel />;
  if (tool.id === 'prepareForm') return <PrepareFormPanel />;
  if (tool.id === 'pageMarks') return <PageMarksPanel />;
  if (tool.id === 'redact') return <RedactPanel tool={tool} />;
  if (tool.id === 'certificates') return <SignaturesPanel />;
  if (tool.id === 'standards') return <StandardsPanel />;
  if (tool.id === 'accessibility') return <AccessibilityPanel />;
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
