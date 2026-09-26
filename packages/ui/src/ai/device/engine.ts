import { isTauriHost } from '../../core/host-tauri';
import type { DeviceModel } from './models';

/**
 * The engine behind "On this device": llama.cpp, running in the desktop host
 * (`tauriEngine.ts`, through `src-tauri/src/ai.rs`) or in WebAssembly in the
 * page (`wllamaEngine.ts`). The panel and the settings speak to this one
 * interface; which engine answers is decided once, by where the app runs.
 *
 * A test may install its own (`__WARRAQ_DEVICE_ENGINE__` on the page before
 * the app loads): the browser tests do, so no test ever downloads a model,
 * and the panel, the preflight and the review are proven the same way in
 * every host. Nothing in a shipped page sets it.
 */

export type ModelState =
  | { kind: 'missing' }
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'ready'; bytes: number }
  /** The engine cannot run here at all (no WebAssembly, no storage): the reason, in the engine's words. */
  | { kind: 'unavailable'; reason: string };

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface GenerateOptions {
  /** A GBNF grammar the answer must follow (from a JSON Schema, `grammar.ts`). */
  grammar?: string;
  maxTokens: number;
  onToken: (text: string) => void;
  signal: AbortSignal;
}

export interface Generated {
  text: string;
  /** Stopped at `maxTokens`, not at the model's own end. */
  cutOff: boolean;
  /** Tokens written, and the time they took: what the settings show as speed. */
  tokens: number;
  ms: number;
}

/** Where the model runs, for the preflight's "sent to" line. */
export type Runtime = 'metal' | 'cpu' | 'wasm' | 'wasm-threads' | 'test';

export interface DeviceEngine {
  model: DeviceModel;
  runtime(): Promise<Runtime>;
  /** Total memory of this machine in GiB, when it says. */
  memoryGiB(): Promise<number | null>;
  status(): Promise<ModelState>;
  /** Fetches the model — only ever called from the download button — verifying it before it is kept. */
  download(onProgress: (received: number, total: number) => void, signal: AbortSignal): Promise<void>;
  remove(): Promise<void>;
  generate(messages: readonly ChatMessage[], options: GenerateOptions): Promise<Generated>;
}

/** What a test installs: a factory, so each page load gets a fresh engine. */
type Installed = { __WARRAQ_DEVICE_ENGINE__?: (model: DeviceModel) => DeviceEngine };

let engine: Promise<DeviceEngine> | null = null;
let engineModelId: string | null = null;

/** The engine for `model`, made once; a different model makes a new one. */
export function deviceEngine(model: DeviceModel): Promise<DeviceEngine> {
  if (engine && engineModelId === model.id) return engine;
  engineModelId = model.id;
  const installed = (globalThis as Installed).__WARRAQ_DEVICE_ENGINE__;
  if (installed) {
    engine = Promise.resolve(installed(model));
  } else if (isTauriHost()) {
    engine = import('./tauriEngine').then(({ tauriEngine }) => tauriEngine(model));
  } else {
    // wllama is loaded only when it is needed: it is not part of the app's first paint.
    engine = import('./wllamaEngine').then(({ wllamaEngine }) => wllamaEngine(model));
  }
  return engine;
}

/** Whether a browser can run the model at all: WebAssembly, and a place to keep the file. */
export function browserCanRun(): { ok: true } | { ok: false; reason: string } {
  if (typeof WebAssembly === 'undefined') return { ok: false, reason: 'no WebAssembly' };
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return { ok: false, reason: 'no storage' };
  return { ok: true };
}
