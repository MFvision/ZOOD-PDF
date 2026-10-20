import { forwardRef, useEffect, useState } from 'react';
import { Library, Send, Sparkles } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import { chosenChips } from '../ai/chat/chips';
import { useSettings } from '../state/settings';
import { localAddress } from '../ai/providers';
import { postAiRequest } from '../ai/request';
import { hasLibrary } from '../ai/chat/library';
import type { AiRequest } from '../ai/request';
import { readSettings } from '../ai/store';
import { DeviceSection } from '../ai/device/DeviceSection';
import { useDeviceModel } from '../ai/device/useDeviceModel';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { toolColor } from '../tools/ToolIcon';

/**
 * The AI Assistant, docked at the home screen's side: the chat's own quick
 * actions and a question. Pressing one opens the AI tool and puts that
 * request into its chat — of the open document, or, there being none on the
 * home screen, of the PDF it then asks for. On this device nothing leaves;
 * for Claude and a local server the chat shows what would go where first,
 * and sends nothing until its Send button is pressed. The card says which
 * provider that is.
 */
export const AiCard = forwardRef<HTMLTextAreaElement, { className?: string }>(function AiCard({ className }, ref) {
  const { t } = useI18n();
  const dispatch = useAppDispatch();
  const state = useAppState();
  const services = useServices();
  const [question, setQuestion] = useState('');
  // "Ask about all my documents": the question goes to the Library's chat, answered from every indexed document.
  const [everything, setEverything] = useState(false);
  const [library, setLibrary] = useState(false);
  useEffect(() => {
    let alive = true;
    void hasLibrary().then((ready) => {
      if (alive) setLibrary(ready);
    });
    return () => {
      alive = false;
    };
  }, []);
  const appSettings = useSettings();
  const settings = readSettings();
  // The on-device model, where the person first meets the assistant: when it
  // is not on this machine yet, the one button that fetches it is here, not
  // only in the tool's panel and Settings.
  const device = useDeviceModel(settings.deviceModel);
  const needsModel = settings.provider === 'device' && device.status !== null && device.status.kind !== 'ready';
  const address = localAddress(settings.localUrl);
  const provider =
    settings.provider === 'device'
      ? t('ai.card.providerDevice')
      : settings.provider === 'claude'
        ? t('ai.card.providerClaude')
        : t('ai.card.providerLocal', { host: address.ok ? new URL(address.base).host : settings.localUrl });

  const ask = (request: AiRequest) => {
    postAiRequest(request);
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'ai' });
    // The Library needs no open file; a question about one document asks for it.
    if (state.document === null && request.scope !== 'library') services.requestOpenFile();
  };

  return (
    <aside className={className ? `home-ai glass ${className}` : 'home-ai glass'} aria-labelledby="home-ai-title">
      <div className="home-ai-head">
        <span className="tool-icon tool-icon-regular" style={{ '--tool-color': toolColor('ai') } as CSSProperties} aria-hidden="true">
          <Icon of={Sparkles} size={18} />
        </span>
        <div>
          <h2 id="home-ai-title">{t('ai.card.title')}</h2>
          <p>{t('ai.card.intro')}</p>
        </div>
      </div>
      {needsModel && <DeviceSection view={device} showDelete={false} compact />}
      <ul className="home-ai-chips" aria-label={t('ai.card.chips')}>
        {chosenChips(appSettings.aiPrompts, appSettings.hiddenAiPrompts).map((chip) => (
          <li key={chip.id}>
            <button type="button" className="home-chip" onClick={() => ask({ kind: chip.kind, text: t(chip.prompt) })}>
              {t(chip.label)}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="home-ai-ask"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim().length === 0) return;
          ask(everything && library ? { kind: 'question', text: question.trim(), scope: 'library' } : { kind: 'question', text: question.trim() });
          setQuestion('');
        }}
      >
        <textarea
          ref={ref}
          className="text-input home-ai-question"
          aria-label={t(everything ? 'ai.card.askAll' : 'ai.card.ask')}
          placeholder={t(everything ? 'ai.scope.placeholderLibrary' : 'ai.card.ask')}
          dir="auto"
          rows={2}
          maxLength={2000}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <IconButton label={t('ai.card.go')} icon={<Icon of={Send} mirror />} variant="primary" type="submit" disabled={question.trim().length === 0} />
      </form>
      <button
        type="button"
        className="home-ai-everything"
        aria-pressed={everything}
        disabled={!library}
        title={library ? t('ai.card.askAllHint') : t('ai.scope.noLibrary')}
        onClick={() => setEverything((on) => !on)}
      >
        <Icon of={Library} size={14} />
        <span>{t('ai.card.askAll')}</span>
      </button>
      <p className="home-ai-note">{state.document === null && !everything ? `${t('ai.card.needsFile')} ${provider}` : provider}</p>
    </aside>
  );
});
