import { createRuntime, handleRequest, toCoreError } from './handlers';
import type { CoreRuntime } from './handlers';
import { loadCoreModule } from './loadModule';
import type { CoreRequest, CoreResponse } from './protocol';

/**
 * Web Worker entry: hosts the core module (WASM or mock) off the UI thread.
 * Minimal scope typing keeps the package on the DOM lib without lib conflicts.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<CoreRequest>) => void) | null;
  postMessage(message: CoreResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

let runtimePromise: Promise<CoreRuntime> | null = null;

function getRuntime(forceMock: boolean): Promise<CoreRuntime> {
  runtimePromise ??= loadCoreModule(forceMock).then(({ module, status }) => createRuntime(module, status));
  return runtimePromise;
}

scope.onmessage = async (event) => {
  const request = event.data;
  try {
    const runtime = await getRuntime(request.kind === 'init' && request.mock === true);
    const { result, transfer } = handleRequest(runtime, request);
    scope.postMessage({ id: request.id, ok: true, result }, transfer);
  } catch (err) {
    scope.postMessage({ id: request.id, ok: false, error: toCoreError(err) });
  }
};
