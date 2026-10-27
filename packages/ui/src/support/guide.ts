import { TOOLS } from '../tools/tools';
import type { Lang } from '../i18n/messages';
import type { Article, Bilingual, GuideStep, Run, Target } from './articles';
import { OPEN_STEPS } from './articles';

/**
 * "Show me" and "Do it for me": an article's guide, step by step, on the
 * real app. A glowing pointer moves to each control in turn. Show me waits
 * for the person to press it (or "Do this step"); Do it for me presses it
 * itself, slowly enough to follow. Controls are found by their own words in
 * the language on screen, so a guide follows the app as it is laid out now,
 * whatever the menu style or the side panel; a step whose control is not
 * there says so and stops, rather than pressing something else.
 *
 * Only ZOOD's own window: the pointer never leaves the app.
 */

export type GuideMode = 'show' | 'do';

export interface GuideView {
  article: Article;
  mode: GuideMode;
  /** Where the pointer is, and the control's box. Null while it looks. */
  box: { x: number; y: number; width: number; height: number } | null;
  say: Bilingual;
  index: number;
  total: number;
  phase: 'looking' | 'pointing' | 'pressing' | 'waiting' | 'done' | 'lost';
}

type Listener = (view: GuideView | null) => void;
const listeners = new Set<Listener>();
let current: GuideView | null = null;
let stopCurrent: (() => void) | null = null;
let stepRequest: (() => void) | null = null;
let runs = 0;

function publish(view: GuideView | null): void {
  current = view;
  for (const listener of listeners) listener(view);
}

export function onGuide(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

export function stopGuide(): void {
  stopCurrent?.();
}

/** Show me's "Do this step": the app presses it instead. */
export function doThisStep(): void {
  stepRequest?.();
}

export interface GuideHost {
  lang: Lang;
  t: (key: never) => string;
  hasDocument: () => boolean;
  run: (what: Run) => void;
  /** Reduce motion: the pointer jumps, and Do it for me waits less. */
  reduced: boolean;
}

/* ------------------------------------------------------------------ finding */

function visible(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest('[hidden], [inert], .guide-layer')) return false;
  if (element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && !(element as HTMLButtonElement).disabled;
}

function nameOf(element: HTMLElement): string {
  return (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const CONTROLS = 'button, [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="radio"], [role="button"], a[href]';

/** A visible control whose name is `words`: the exact name first, then one that starts with it. */
export function findByWords(words: string, root: ParentNode = document): HTMLElement | null {
  const wanted = words.replace(/\s+/g, ' ').trim();
  if (!wanted) return null;
  const all = [...root.querySelectorAll(CONTROLS)].filter(visible);
  return all.find((one) => nameOf(one) === wanted) ?? all.find((one) => nameOf(one).startsWith(wanted)) ?? null;
}

export interface Found {
  element: HTMLElement;
  /** Pressing it reaches the step's goal; otherwise it opens the way there and the step looks again. */
  final: boolean;
}

/** Where a target is on screen right now. */
export function locate(target: Target, t: (key: never) => string, root: ParentNode = document): Found | null {
  if (target.kind === 'css') {
    const element = [...root.querySelectorAll(target.selector)].find(visible);
    return element ? { element, final: true } : null;
  }
  if (target.kind === 'label') {
    const element = findByWords(t(target.label as never), root);
    return element ? { element, final: true } : null;
  }
  const tool = TOOLS.find((one) => one.id === target.tool);
  if (!tool) return null;
  const name = t(tool.labelKey as never);
  // The tool open already: its panel is the place.
  const picker = [...root.querySelectorAll('.toolbar-tool-picker')].find(visible) as HTMLElement | undefined;
  if (picker && (picker.textContent ?? '').trim() === name) {
    const pane = [...root.querySelectorAll('.pane-end')].find(visible);
    if (pane) return { element: pane, final: true };
  }
  for (const selector of ['.tool-gallery-item', '.tool-card']) {
    const element = [...root.querySelectorAll<HTMLElement>(selector)].find((one) => visible(one) && nameOf(one) === name);
    if (element) return { element, final: true };
  }
  if (picker) return { element: picker, final: false };
  return null;
}

/* ------------------------------------------------------------------ running */

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('stopped', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('stopped', 'AbortError'));
    }, { once: true });
  });

async function waitFor<T>(look: () => T | null, ms: number, signal: AbortSignal): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const found = look();
    if (found) return found;
    if (Date.now() > until) return null;
    await sleep(150, signal);
  }
}

function boxOf(element: HTMLElement): GuideView['box'] {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** Resolves when the person presses the control themselves (the press goes through as usual). */
function pressedBy(element: HTMLElement, signal: AbortSignal): Promise<'person'> {
  return new Promise((resolve, reject) => {
    const onPress = (event: Event) => {
      if (event.target instanceof Node && element.contains(event.target)) {
        cleanup();
        // After the app has had the click.
        setTimeout(() => resolve('person'), 0);
      }
    };
    const cleanup = () => document.removeEventListener('click', onPress, true);
    document.addEventListener('click', onPress, true);
    signal.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('stopped', 'AbortError'));
    }, { once: true });
  });
}

function stepAsked(signal: AbortSignal): Promise<'app'> {
  return new Promise((resolve, reject) => {
    stepRequest = () => {
      stepRequest = null;
      resolve('app');
    };
    signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true });
  });
}

/** Said while the pointer is on the tool picker on the way to a tool, which still shows the tool open now. */
const OPEN_TOOLS: Bilingual = { ar: 'افتح قائمة الأدوات من هنا أولاً.', en: 'First open the tools list here.' };
const DONE: Bilingual = { ar: 'انتهينا! هذا كل شيء.', en: 'Done! That’s all there is to it.' };
const LOST: Bilingual = {
  ar: 'لم أجد هذا الزر على الشاشة الآن. أغلق النوافذ المفتوحة وجرّب مرة أخرى، أو اتبع الخطوات المكتوبة.',
  en: 'I can’t find that button on screen right now. Close any open windows and try again, or follow the written steps.',
};

/** Runs one article's guide. Resolves when it ends, however it ends. */
export async function runGuide(article: Article, mode: GuideMode, host: GuideHost): Promise<'done' | 'lost' | 'stopped'> {
  if (!article.guide) return 'lost';
  stopCurrent?.();
  const run = ++runs;
  const controller = new AbortController();
  const { signal } = controller;
  stopCurrent = () => controller.abort();
  const steps: GuideStep[] = [...(article.guide.needs === 'document' && !host.hasDocument() ? OPEN_STEPS : []), ...article.guide.steps];
  let shown: GuideView = { article, mode, box: null, say: steps[0]!.say, index: 0, total: steps.length, phase: 'looking' };
  const view = (patch: Partial<GuideView>) => {
    shown = { ...shown, ...patch };
    if (run === runs) publish(shown);
  };
  const pace = host.reduced ? 250 : 900;
  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      view({ index, say: step.say, phase: 'looking', box: null });
      if (step.run) {
        host.run(step.run);
        await sleep(400, signal);
        const sheet = document.querySelector<HTMLElement>('dialog[open] .dialog-body, .remote-sheet');
        view({ box: sheet ? boxOf(sheet) : null, phase: 'pointing' });
        if (mode === 'show') await Promise.race([stepAsked(signal), sleep(60_000, signal)]);
        else await sleep(pace * 2.5, signal);
        continue;
      }
      if (!step.target) continue;
      // A step can take a few presses: the tool picker opens, then the tool in it.
      for (let hops = 0; hops < 3; hops += 1) {
        const found = await waitFor(() => locate(step.target!, host.t), 4000, signal);
        if (!found) {
          view({ phase: 'lost', say: LOST, box: null });
          await sleep(6000, signal);
          return 'lost';
        }
        found.element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        view({ box: boxOf(found.element), phase: 'pointing', say: found.final ? step.say : OPEN_TOOLS });
        const isLast = index === steps.length - 1 && found.final;
        // The last step of a tool guide points at where the tool is; nothing is left to press.
        if (isLast && found.element.matches('.pane-end, .toolbar-title-name')) {
          await sleep(pace * 2, signal);
          break;
        }
        if (mode === 'do') {
          await sleep(pace, signal);
          view({ phase: 'pressing' });
          await sleep(host.reduced ? 80 : 260, signal);
          found.element.click();
        } else {
          const by = await Promise.race([pressedBy(found.element, signal), stepAsked(signal)]);
          if (by === 'app') found.element.click();
        }
        stepRequest = null;
        await sleep(350, signal);
        if (found.final) break;
      }
      if (step.then) {
        view({ phase: 'waiting', say: step.then.say, box: null });
        const arrived = await waitFor(() => locate(step.then!.target, host.t), 5 * 60_000, signal);
        if (!arrived) return 'stopped';
      }
    }
    view({ phase: 'done', say: DONE });
    await sleep(host.reduced ? 1500 : 2600, signal);
    return 'done';
  } catch {
    return 'stopped';
  } finally {
    controller.abort();
    // A newer guide may have taken over; only this one's own state is cleared.
    if (run === runs) {
      stopCurrent = null;
      stepRequest = null;
      publish(null);
    }
  }
}
