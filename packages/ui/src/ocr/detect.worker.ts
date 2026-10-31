import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { detectorInput, regionsOf } from './lines';
import type { Box } from './lines';

/**
 * The line finder's own thread: PaddleOCR's text detector (PP-OCRv5 mobile,
 * Apache-2.0, `ocr/lines.onnx`) run by ONNX Runtime's WebAssembly build (MIT),
 * both served from the app's own origin — nothing is fetched from anywhere
 * else. A page drawn small (`lines.ts` `detectSize`) comes in; the boxes of
 * its lines, in those small pixels, go back. One thread, so it needs no
 * cross-origin isolation, and the interface never waits on it.
 */

export interface DetectJob {
  id: number;
  /** The model's address, resolved by the page that started the worker. */
  model: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export type DetectAnswer = { id: number; ok: true; boxes: Box[] } | { id: number; ok: false; message: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<DetectJob>) => void) | null;
  postMessage(message: DetectAnswer): void;
}

const scope = self as unknown as WorkerScope;
let session: Promise<ort.InferenceSession> | null = null;

function open(model: string): Promise<ort.InferenceSession> {
  if (!session) {
    ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
    session = (async () => {
      const response = await fetch(model);
      if (!response.ok) throw new Error(`E_OCR_MODEL: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })();
    // A failed start is not kept: the next page tries again.
    session.catch(() => {
      session = null;
    });
  }
  return session;
}

scope.onmessage = async (event) => {
  const { id, model, width, height, rgba } = event.data;
  try {
    const net = await open(model);
    const input = new ort.Tensor('float32', detectorInput(rgba, width, height), [1, 3, height, width]);
    const output = await net.run({ [net.inputNames[0]!]: input });
    const map = output[net.outputNames[0]!]!;
    const boxes = regionsOf(map.data as Float32Array, width, height);
    input.dispose();
    map.dispose();
    scope.postMessage({ id, ok: true, boxes });
  } catch (error) {
    scope.postMessage({ id, ok: false, message: String((error as Error)?.message ?? error) });
  }
};
