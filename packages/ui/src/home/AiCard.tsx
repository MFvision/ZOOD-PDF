import { forwardRef, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { localAddress } from '../ai/providers';
import { postAiRequest } from '../ai/request';
import type { AiRequest } from '../ai/request';
import { readSettings } from '../ai/store';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { toolColor } from '../tools/ToolIcon';

interface Chip {
  id: string;
  label: TKey;
  /** The request the chip makes of the AI tool: a task, and for a question its wording. */
  request: (lang: 'ar' | 'en', prompt: (key: TKey) => string) => AiRequest;
}

const CHIPS: Chip[] = [
  { id: 'summarize', label: 'ai.card.chip.summarize', request: () => ({ task: 'summarize' }) },
  { id: 'explain', label: 'ai.card.chip.explain', request: (_, prompt) => ({ task: 'ask', question: prompt('ai.card.prompt.explain') }) },
  { id: 'translate', label: 'ai.card.chip.translate', request: (lang) => ({ task: 'translate', to: lang }) },
  { id: 'keyPoints', label: 'ai.card.chip.keyPoints', request: (_, prompt) => ({ task: 'ask', question: prompt('ai.card.prompt.keyPoints') }) },
  { id: 'quiz', label: 'ai.card.chip.quiz', request: (_, prompt) => ({ task: 'ask', question: prompt('ai.card.prompt.quiz') }) },
  { id: 'email', label: 'ai.card.chip.email', request: (_, prompt) => ({ task: 'ask', question: prompt('ai.card.prompt.email') }) },
];

/**
 * The AI Assistant, docked at the home screen's side: suggestion chips and a
 * question. Each chip is one of the AI tool's own actions, or a question
 * worded for it; pressing one opens the tool with that request chosen, and
 * — there being no document on the home screen — asks for the PDF it is
 * about. The tool then shows exactly what would go where, and sends nothing
 * until its Send button is pressed. The card says which provider that is.
 */
export const AiCard = forwardRef<HTMLTextAreaElement, { className?: string }>(function AiCard({ className }, ref) {
  const { t, lang } = useI18n();
  const dispatch = useAppDispatch();
  const state = useAppState();
  const services = useServices();
  const [question, setQuestion] = useState('');
  const settings = readSettings();
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
    if (state.document === null) services.requestOpenFile();
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
      <ul className="home-ai-chips" aria-label={t('ai.card.chips')}>
        {CHIPS.map((chip) => (
          <li key={chip.id}>
            <button type="button" className="home-chip" onClick={() => ask(chip.request(lang, (key) => t(key)))}>
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
          ask({ task: 'ask', question: question.trim() });
          setQuestion('');
        }}
      >
        <textarea
          ref={ref}
          className="text-input home-ai-question"
          aria-label={t('ai.card.ask')}
          placeholder={t('ai.card.ask')}
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
      <p className="home-ai-note">{state.document === null ? `${t('ai.card.needsFile')} ${provider}` : provider}</p>
    </aside>
  );
});
