import { readJson, writeJson } from '../state/preferences';
import { findStep } from './steps';
import type { SequenceStep, StepId } from './steps';

/**
 * Saved sequences — "actions" — kept on this device only, in the browser's
 * storage (the desktop app's webview has its own). An action keeps its steps
 * and their options, never a password: Protect's are left out, and asked
 * for again when the action is used. Read back, every step and option is
 * checked, so a damaged entry cannot break the panel.
 */

export interface SavedAction {
  name: string;
  steps: { id: StepId; options: unknown }[];
  /** Milliseconds since 1970, when it was saved. */
  savedAt: number;
}

const KEY = 'warraq.batch.actions';
const MAX_ACTIONS = 50;
const MAX_STEPS = 30;
const MAX_NAME = 80;

/** A name as typed, trimmed and cut to length; empty when there is none. */
export function actionName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** Actions read from storage, each step checked by its own definition. */
export function sanitizeActions(raw: unknown): SavedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedAction[] = [];
  for (const entry of raw.slice(0, MAX_ACTIONS)) {
    const given = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (!given || typeof given.name !== 'string') continue;
    const name = actionName(given.name);
    if (!name || out.some((action) => action.name === name)) continue;
    const steps = (Array.isArray(given.steps) ? given.steps : []).slice(0, MAX_STEPS).flatMap((step) => {
      const s = step && typeof step === 'object' ? (step as Record<string, unknown>) : {};
      const definition = typeof s.id === 'string' ? findStep(s.id) : undefined;
      return definition ? [{ id: definition.id, options: definition.sanitize(s.options) }] : [];
    });
    if (steps.length === 0) continue;
    out.push({ name, steps, savedAt: typeof given.savedAt === 'number' ? given.savedAt : 0 });
  }
  return out;
}

export function readActions(): SavedAction[] {
  return sanitizeActions(readJson<unknown>(KEY, []));
}

/**
 * Saves `steps` as the action `name` (replacing one of that name), without
 * any password, and returns every action. Newest first.
 */
export function saveAction(name: string, steps: readonly SequenceStep[], now: number = Date.now()): SavedAction[] {
  const clean = actionName(name);
  if (!clean || steps.length === 0) return readActions();
  const kept = steps.flatMap((step) => {
    const definition = findStep(step.id);
    if (!definition) return [];
    const options = definition.sanitize(step.options);
    return [{ id: definition.id, options: definition.keep ? definition.keep(options) : options }];
  });
  const actions = [{ name: clean, steps: kept, savedAt: now }, ...readActions().filter((action) => action.name !== clean)].slice(0, MAX_ACTIONS);
  writeJson(KEY, actions);
  return actions;
}

export function deleteAction(name: string): SavedAction[] {
  const actions = readActions().filter((action) => action.name !== name);
  writeJson(KEY, actions);
  return actions;
}

/** An action's steps as a sequence to edit and run, keyed from `nextKey`. */
export function sequenceOf(action: SavedAction, nextKey: () => number): SequenceStep[] {
  return action.steps.map((step) => ({ key: nextKey(), id: step.id, options: step.options }));
}
