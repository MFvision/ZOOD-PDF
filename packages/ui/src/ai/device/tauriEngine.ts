import { invokeHost, onHostEvent } from '../../core/host-tauri';
import type { ChatMessage, DeviceEngine, Generated, GenerateOptions, ModelState, Runtime } from './engine';
import { modelBytes } from './models';
import type { DeviceModel } from './models';

/**
 * The desktop's engine: llama.cpp linked into the host
 * (`src-tauri/src/ai.rs`). The model file lives in the app's data directory;
 * the download, its verification and the generation all happen there, and
 * this file only carries the calls and the events back — tokens as
 * `warraq://ai-token`, the download's progress as `warraq://ai-download`.
 */

interface Status {
  state: 'ready' | 'missing' | 'downloading';
  bytes: number;
  received?: number;
  total?: number;
}

interface Done {
  text: string;
  cutOff: boolean;
  tokens: number;
  ms: number;
}

let requests = 0;

export function tauriEngine(model: DeviceModel): DeviceEngine {
  return {
    model,
    runtime: async () => ((await invokeHost('ai_runtime')) === 'metal' ? 'metal' : 'cpu') as Runtime,
    memoryGiB: async () => {
      const bytes = await invokeHost('ai_memory_bytes');
      return typeof bytes === 'number' && bytes > 0 ? bytes / 1024 ** 3 : null;
    },
    status: async () => {
      const status = (await invokeHost('ai_model_status', { id: model.id })) as Status;
      if (status.state === 'ready') return { kind: 'ready', bytes: status.bytes };
      if (status.state === 'downloading') return { kind: 'downloading', received: status.received ?? 0, total: status.total ?? modelBytes(model) };
      return { kind: 'missing' } as ModelState;
    },
    download: async (onProgress, signal) => {
      const stop = onHostEvent<{ id: string; received: number; total: number }>('warraq://ai-download', (progress) => {
        if (progress.id === model.id) onProgress(progress.received, progress.total);
      });
      const cancel = () => void invokeHost('ai_model_cancel_download', { id: model.id }).catch(() => undefined);
      signal.addEventListener('abort', cancel);
      try {
        await invokeHost('ai_model_download', { id: model.id });
      } finally {
        signal.removeEventListener('abort', cancel);
        stop();
      }
    },
    remove: async () => {
      await invokeHost('ai_model_delete', { id: model.id });
    },
    countTokens: async (text: string) => {
      const count = await invokeHost('ai_count_tokens', { model: model.id, text });
      if (typeof count !== 'number') throw new Error('E_AI: no count');
      return count;
    },
    generate: async (messages: readonly ChatMessage[], options: GenerateOptions): Promise<Generated> => {
      requests += 1;
      const id = `${Date.now()}-${requests}`;
      let text = '';
      const stop = onHostEvent<{ id: string; text: string }>('warraq://ai-token', (token) => {
        if (token.id !== id) return;
        text += token.text;
        options.onToken(token.text);
      });
      const cancel = () => void invokeHost('ai_cancel', { id }).catch(() => undefined);
      options.signal.addEventListener('abort', cancel);
      try {
        const done = (await invokeHost('ai_generate', {
          request: { id, model: model.id, messages, grammar: options.grammar ?? null, maxTokens: options.maxTokens, contextTokens: options.contextTokens ?? null },
        })) as Done;
        // The host's text is the whole answer; the events were its pieces.
        return { text: done.text || text, cutOff: done.cutOff, tokens: done.tokens, ms: done.ms };
      } finally {
        options.signal.removeEventListener('abort', cancel);
        stop();
      }
    },
  };
}
