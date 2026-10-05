import type { Lang } from '../i18n/messages';
import type { Budgeted } from './budget';
import { buildPrompt } from './prompt';
import type { AiTask } from './prompt';
import { CLAUDE_HOST, claudeRequest, localRequest } from './providers';
import type { LocalApi, Prompt, ProviderRequest } from './providers';

/** Where a request goes: this device's own model, Claude with a model, or a local server (address from `localAddress`). */
export type ProviderSettings =
  | { provider: 'device'; model: string; runtime: string }
  | { provider: 'claude'; model: string }
  | { provider: 'local'; api: LocalApi; base: string; model: string };

/** What the preflight names as the destination of an on-device request: nowhere. */
export const THIS_DEVICE = 'this device';

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
  /** Anthropic's host, the local server's address, or `THIS_DEVICE`. */
  destination: string;
  /**
   * A long document, for the on-device model, goes as the passages that
   * answer the question rather than whole pages: `pages` are then the pages
   * those passages came from, and `characters` what they hold.
   */
  passages: boolean;
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
  /** The pages are passages chosen for the question, not whole pages. */
  passages?: boolean;
}

export function preflightFor(
  settings: ProviderSettings,
  task: AiTask,
  budgeted: Budgeted,
  context: PreflightContext,
): Preflight {
  const { sent, left, characters } = budgeted;
  const prompt = buildPrompt(task, sent, { lang: context.lang, pageCount: context.pageCount, left, passages: context.passages ?? false });
  // Smart fill sends no pages: the form's fields, from the pages they are
  // on, and the person's details — counted whole, as they are sent.
  const fill = task.kind === 'fill' ? task : null;
  return {
    settings,
    task,
    destination: settings.provider === 'claude' ? CLAUDE_HOST : settings.provider === 'local' ? settings.base : THIS_DEVICE,
    pages: fill ? [...new Set(fill.fields.map((field) => field.page))].sort((a, b) => a - b) : sent.map((page) => page.page),
    left: [...left],
    pageCount: context.pageCount,
    characters: fill ? prompt.user.length : characters,
    budget: context.budget,
    empty: fill ? fill.fields.length === 0 : sent.every((page) => page.text.trim().length === 0),
    passages: context.passages ?? false,
    prompt,
  };
}

/**
 * The request Send makes for `preflight`; `key` is used for Claude only, in
 * its one header. An on-device request is no HTTP request at all
 * (`device/generate.ts`), and asking for one is a mistake in the caller.
 */
export function requestFor(preflight: Preflight, key: string): ProviderRequest {
  const { settings, prompt } = preflight;
  if (settings.provider === 'device') throw new Error('E_DEVICE: an on-device request is not sent anywhere');
  return settings.provider === 'claude'
    ? claudeRequest(key, settings.model, prompt)
    : localRequest(settings.api, settings.base, settings.model, prompt);
}
