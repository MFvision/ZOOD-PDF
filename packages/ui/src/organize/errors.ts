/** Engine errors → the user's language (known codes), else the engine's own message. */
import en from '../i18n/en.json';
import type { MessageKey, Translate } from '../i18n';
import { EngineError } from '../services/engine';

export function errorText(t: Translate, e: unknown): string {
  if (e instanceof EngineError) {
    const key = `error.${e.code}`;
    if (key in en) return t(key as MessageKey);
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** "report.pdf" → "report". */
export function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '') || name;
}
