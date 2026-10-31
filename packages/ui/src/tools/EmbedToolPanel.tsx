import { Icon } from '../components/Icon';
import { FormNotices } from '../forms/FormNotices';
import { useFormRuntime } from '../forms/FormRuntime';
import { WalletFill } from '../ai/profile/WalletFill';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppState, useServices } from '../state/AppContext';
import { warraqOwnsDocument } from '../state/appReducer';
import type { ToolDefinition } from './tools';
import { OpenFirst } from './OpenFirst';

/**
 * The panel of a tool that EmbedPDF implements (ADR-0007): every button runs a
 * command its viewer registers, labelled in Warraq's own languages — which is
 * also how Arabic reaches controls whose toolbar is English-only in 2.15.
 */
export function EmbedToolPanel({ tool }: { tool: ToolDefinition }) {
  const t = useT();
  const state = useAppState();
  const { runEmbedCommand, documentPassword } = useServices();
  // A file that opened with a password: Protect's one button also takes it
  // off, which nothing said; it read "Set a password" (First Five, Rami).
  const locked = tool.id === 'protect' && documentPassword !== undefined && documentPassword !== '';
  const { model } = useFormRuntime();
  const ready =
    state.view === 'viewer' && state.document !== null && !warraqOwnsDocument(state) && state.switching === null;

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={tool.icon} />
        {t(tool.labelKey)}
      </h3>
      {!ready && <OpenFirst />}
      {tool.id === 'fillSign' && <FormNotices />}
      {tool.id === 'fillSign' && ready && model && model.fields.length === 0 && (
        <p className="tool-panel-note" role="note">{t('tool.fillSign.noFields')}</p>
      )}
      <div className="tool-actions">
        {(tool.actions ?? []).map((action) => (
          <IconButton
            key={action.command}
            label={t(locked && action.command === 'document:protect' ? 'action.changePassword' : action.labelKey)}
            icon={<Icon of={action.icon} />}
            showLabel
            disabled={!ready}
            onClick={() => runEmbedCommand(action.command)}
          />
        ))}
      </div>
      {locked && ready && <p className="tool-panel-note">{t('tool.protect.removeNote')}</p>}
      {(tool.id === 'comment' || tool.id === 'fillSign') && (
        <p className="tool-panel-note">{t('tool.arabicDrawNote')}</p>
      )}
      {tool.id === 'fillSign' && ready && <WalletFill />}
      {tool.id === 'redact' && <p className="tool-panel-note">{t('tool.redactNote')}</p>}
    </div>
  );
}
