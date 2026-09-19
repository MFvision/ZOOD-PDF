import { Icon } from '../components/Icon';
import { FormNotices } from '../forms/FormNotices';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppState, useServices } from '../state/AppContext';
import { warraqOwnsDocument } from '../state/appReducer';
import type { ToolDefinition } from './tools';

/**
 * The panel of a tool that EmbedPDF implements (ADR-0007): every button runs a
 * command its viewer registers, labelled in Warraq's own languages — which is
 * also how Arabic reaches controls whose toolbar is English-only in 2.15.
 */
export function EmbedToolPanel({ tool }: { tool: ToolDefinition }) {
  const t = useT();
  const state = useAppState();
  const { runEmbedCommand } = useServices();
  const ready =
    state.view === 'viewer' && state.document !== null && !warraqOwnsDocument(state) && state.switching === null;

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={tool.icon} />
        {t(tool.labelKey)}
      </h3>
      {!ready && <p className="tool-panel-note">{t('tool.openFirst')}</p>}
      {tool.id === 'fillSign' && <FormNotices />}
      <div className="tool-actions">
        {(tool.actions ?? []).map((action) => (
          <IconButton
            key={action.command}
            label={t(action.labelKey)}
            icon={<Icon of={action.icon} />}
            showLabel
            disabled={!ready}
            onClick={() => runEmbedCommand(action.command)}
          />
        ))}
      </div>
      {(tool.id === 'comment' || tool.id === 'fillSign') && (
        <p className="tool-panel-note">{t('tool.arabicDrawNote')}</p>
      )}
      {tool.id === 'redact' && <p className="tool-panel-note">{t('tool.redactNote')}</p>}
    </div>
  );
}
