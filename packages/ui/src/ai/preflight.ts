import type { Lang } from '../i18n/messages';
import type { Budgeted } from './budget';
import { buildPrompt } from './prompt';
import type { AiTask } from './prompt';
import { CLAUDE_HOST, claudeRequest, localRequest } from './providers';
import type { LocalApi, Prompt, ProviderRequest } from './providers';

/** Where a request goes: Claude with a model, or a local server (address from `localAddress`). */
export type ProviderSettings =
  | { provider: 'claude'; model: string }
  | { provider: 'local'; api: LocalApi; base: string; model: string };

/**
 * What the person sees before anything leaves the device, and exactly what
 * Send then sends: the provider and model, where it goes, which pages, how
 * many characters, and which pages were left out. Send builds its request
 * from this and nothing else, so the screen cannot show one thing and the
 * request carry another.
 */
export interface Preflight {
  settings: ProviderSettings;
  task: AiTask;
  /** Anthropic's host, or the local server's address. */
  destination: string;
  /** Pages sent, whole, in order. */
  pages: number[];
  /** Pages asked for but left out, over the budget. */
  left: number[];
  pageCount: number;
  /** Characters of document text sent. */
  characters: number;
  budget: number;
  /** The pages to send have no text Warraq can read — a scan, say — so there is nothing to send. */
  empty: boolean;
  prompt: Prompt;
}

export interface PreflightContext {
  lang: Lang;
  pageCount: number;
  budget: number;
}

export function preflightFor(settings: ProviderSettings, task: AiTask, budgeted: Budgeted, context: PreflightContext): Preflight {
  const { sent, left, characters } = budgeted;
  return {
    settings,
    task,
    destination: settings.provider === 'claude' ? CLAUDE_HOST : settings.base,
    pages: sent.map((page) => page.page),
    left: [...left],
    pageCount: context.pageCount,
    characters,
    budget: context.budget,
    empty: sent.every((page) => page.text.trim().length === 0),
    prompt: buildPrompt(task, sent, { lang: context.lang, pageCount: context.pageCount, left }),
  };
}

/** The request Send makes for `preflight`; `key` is used for Claude only, in its one header. */
export function requestFor(preflight: Preflight, key: string): ProviderRequest {
  const { settings, prompt } = preflight;
  return settings.provider === 'claude'
    ? claudeRequest(key, settings.model, prompt)
    : localRequest(settings.api, settings.base, settings.model, prompt);
}
