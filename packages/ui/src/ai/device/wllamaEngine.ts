// The built module and its WebAssembly, not the package's TypeScript sources.
import { Wllama } from '@wllama/wllama/esm/index.js';
import wllamaWasm from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import { browserCanRun } from './engine';
import type { ChatMessage, DeviceEngine, Generated, GenerateOptions, ModelState, Runtime } from './engine';
import type { DeviceModel } from './models';
import { sha256Stream } from './sha256';

/**
 * The browser's engine: wllama (MIT), llama.cpp compiled to WebAssembly,
 * with the model in the origin's private file system. Multi-threaded where
 * the page is cross-origin isolated, single-threaded otherwise — the panel
 * says which, and says plainly that answers here are weaker than on the
 * desktop, where the larger model runs on the machine's own hardware.
 *
 * The WebAssembly comes from this origin, like every other asset (nothing
 * from a CDN); the model comes from Hugging Face, on the download button
 * only, and is kept once its SHA-256 matches `models.json`.
 */

/** The window the model is given: what a 0.5B model attends over usefully, and what a phone's memory holds. */
const CONTEXT_TOKENS = 4096;

export function wllamaEngine(model: DeviceModel): DeviceEngine {
  const can = browserCanRun();
  let wllama: Wllama | null = null;
  let loaded = false;

  const instance = () => {
    // One WebAssembly build: wllama runs it on several threads where the
    // page is cross-origin isolated, on one otherwise.
    wllama ??= new Wllama({ default: wllamaWasm }, { suppressNativeLog: true, allowOffline: true });
    return wllama;
  };

  /** The file as the cache holds it, complete or not. */
  const cached = async (): Promise<{ name: string; size: number } | null> => {
    const cache = instance().cacheManager;
    const name = await cache.getNameFromURL(model.url);
    const size = await cache.getSize(name);
    return size >= 0 ? { name, size } : null;
  };

  const load = async () => {
    if (loaded) return;
    await instance().loadModelFromUrl(model.url, { useCache: true, n_ctx: CONTEXT_TOKENS, n_batch: 512 });
    loaded = true;
  };

  return {
    model,
    runtime: async (): Promise<Runtime> => (globalThis.crossOriginIsolated ? 'wasm-threads' : 'wasm'),
    memoryGiB: async () => {
      const memory = (navigator as { deviceMemory?: number }).deviceMemory;
      return typeof memory === 'number' ? memory : null;
    },
    status: async (): Promise<ModelState> => {
      if (!can.ok) return { kind: 'unavailable', reason: can.reason };
      try {
        const file = await cached();
        return file && file.size === model.bytes ? { kind: 'ready', bytes: file.size } : { kind: 'missing' };
      } catch (error) {
        return { kind: 'unavailable', reason: String(error) };
      }
    },
    download: async (onProgress, signal) => {
      if (!can.ok) throw new Error(`E_DEVICE: ${can.reason}`);
      const cache = instance().cacheManager;
      await cache.download(model.url, {
        signal,
        progressCallback: ({ loaded: received, total }) => onProgress(received, total || model.bytes),
      });
      // What arrived is checked against the size and the checksum the
      // catalogue carries before it is ever loaded: a wrong file is deleted.
      const name = await cache.getNameFromURL(model.url);
      const blob = await cache.open(name);
      const size = blob?.size ?? -1;
      const digest = blob ? await sha256Stream(blob.stream()) : '';
      if (size !== model.bytes || digest !== model.sha256) {
        await cache.delete(name).catch(() => undefined);
        throw new Error(`E_DEVICE_VERIFY: the download did not match (size ${size}, sha256 ${digest.slice(0, 12)}…)`);
      }
    },
    remove: async () => {
      if (wllama) {
        await wllama.exit().catch(() => undefined);
        loaded = false;
      }
      await instance().cacheManager.delete(model.url);
    },
    generate: async (messages: readonly ChatMessage[], options: GenerateOptions): Promise<Generated> => {
      await load();
      const started = performance.now();
      let text = '';
      let tokens = 0;
      let cutOff = false;
      await instance().createChatCompletion({
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        max_tokens: options.maxTokens,
        abortSignal: options.signal,
        temp: options.grammar ? 0 : 0.3,
        ...(options.grammar ? { grammar: options.grammar } : {}),
        onData: (chunk) => {
          const choice = chunk.choices[0];
          const piece = choice?.delta.content ?? '';
          if (piece) {
            text += piece;
            tokens += 1;
            options.onToken(piece);
          }
          if (choice?.finish_reason === 'length') cutOff = true;
        },
      });
      return { text, cutOff, tokens, ms: Math.round(performance.now() - started) };
    },
  };
}
