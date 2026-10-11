import type { TKey } from '../../i18n/messages';
import type { Ask } from './answer';

/**
 * The quick actions over the chat's input, and on the home screen's
 * assistant card. Each is no more than a worded request sent into the same
 * chat — what it sends is what appears there as the person's message.
 */
export interface Chip {
  id: 'summarize' | 'keyPoints' | 'explain' | 'translate' | 'email' | 'quiz';
  label: TKey;
  /** The words it sends. */
  prompt: TKey;
  kind: Ask['kind'];
}

export const CHIPS: readonly Chip[] = [
  { id: 'summarize', label: 'ai.card.chip.summarize', prompt: 'ai.card.prompt.summarize', kind: 'overview' },
  { id: 'keyPoints', label: 'ai.card.chip.keyPoints', prompt: 'ai.card.prompt.keyPoints', kind: 'overview' },
  { id: 'explain', label: 'ai.card.chip.explain', prompt: 'ai.card.prompt.explain', kind: 'overview' },
  { id: 'translate', label: 'ai.card.chip.translate', prompt: 'ai.card.prompt.translate', kind: 'translate' },
  { id: 'email', label: 'ai.card.chip.email', prompt: 'ai.card.prompt.email', kind: 'overview' },
  { id: 'quiz', label: 'ai.card.chip.quiz', prompt: 'ai.card.prompt.quiz', kind: 'overview' },
];
