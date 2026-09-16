import { createMockModule } from './mock';
import type { CoreModule, CoreStatus } from './types';

type WasmEntry = CoreModule & { default: (input?: unknown) => Promise<unknown> };

/**
 * `import.meta.glob` is resolved at build time and yields `{}` when the
 * wasm-pack output is absent, so the Vite build never fails without the core.
 */
const candidates = import.meta.glob('../core-wasm/warraq_core.js');

export interface LoadedCore {
  module: CoreModule;
  status: CoreStatus;
}

/** `forceMock` (from `?core=mock` in the host) skips the WASM module for testing the fallback. */
export async function loadCoreModule(forceMock = false): Promise<LoadedCore> {
  const load = candidates['../core-wasm/warraq_core.js'];
  if (load && !forceMock) {
    try {
      const entry = (await load()) as WasmEntry;
      await entry.default();
      return { module: entry, status: { kind: 'wasm', version: entry.version() } };
    } catch (err) {
      console.warn('[warraq] WASM core failed to load; falling back to the mock core.', err);
    }
  }
  const module = createMockModule();
  return { module, status: { kind: 'mock', version: module.version() } };
}
