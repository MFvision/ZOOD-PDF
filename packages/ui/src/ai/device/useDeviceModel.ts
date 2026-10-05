import { useCallback, useEffect, useRef, useState } from 'react';
import { invokeHost, isTauriHost } from '../../core/host-tauri';
import { deviceEngine } from './engine';
import type { DeviceEngine, ModelState, Runtime } from './engine';
import { defaultModelFor, deviceModel } from './models';
import type { DeviceModel, DeviceModelId } from './models';

/**
 * The on-device model as the panel and the settings see it: which one this
 * machine gets, whether it is here, and the download — started only by the
 * button that calls `download`. One hook, two places, the same state.
 */
export interface DeviceModelView {
  model: DeviceModel;
  status: ModelState | null;
  runtime: Runtime | null;
  /** Why the last download failed, in the engine's words. */
  error: string | null;
  download(): void;
  cancelDownload(): void;
  remove(): Promise<void>;
  refresh(): Promise<void>;
}

/** This machine's memory in GiB, where it says: the host on the desktop, `navigator.deviceMemory` in a browser. */
export async function machineMemoryGiB(): Promise<number | null> {
  if (isTauriHost()) {
    try {
      const bytes = await invokeHost('ai_memory_bytes');
      return typeof bytes === 'number' && bytes > 0 ? bytes / 1024 ** 3 : null;
    } catch {
      return null;
    }
  }
  const memory = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  return typeof memory === 'number' ? memory : null;
}

/** The model for this machine: the chosen one, else the one its memory and its host call for. */
export function useDefaultModel(chosen: DeviceModelId | null): DeviceModel {
  const [fallback, setFallback] = useState<DeviceModel>(() => defaultModelFor(null, !isTauriHost()));
  useEffect(() => {
    let cancelled = false;
    void machineMemoryGiB().then((memory) => {
      if (!cancelled) setFallback(defaultModelFor(memory, !isTauriHost()));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return chosen ? deviceModel(chosen) : fallback;
}

const DEVICE_MODEL_CHANGED = 'warraq:device-model-changed';

function announceChange(): void {
  globalThis.dispatchEvent?.(new Event(DEVICE_MODEL_CHANGED));
}

export function useDeviceModel(chosen: DeviceModelId | null): DeviceModelView {
  const model = useDefaultModel(chosen);
  const [status, setStatus] = useState<ModelState | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const engineRef = useRef<Promise<DeviceEngine> | null>(null);

  const engine = useCallback(() => {
    engineRef.current = deviceEngine(model);
    return engineRef.current;
  }, [model]);

  const refresh = useCallback(async () => {
    try {
      const current = await engine();
      const [next, where] = await Promise.all([current.status(), current.runtime()]);
      setStatus(next);
      setRuntime(where);
    } catch (failure) {
      setStatus({ kind: 'unavailable', reason: failure instanceof Error ? failure.message : String(failure) });
    }
  }, [engine]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The model is one thing on the device, but this hook is used in more than
  // one place at once (the AI panel and Settings): a download or a removal in
  // one is told to the others, or the panel goes on believing in a model
  // Settings has just deleted.
  useEffect(() => {
    const again = () => void refresh();
    globalThis.addEventListener?.(DEVICE_MODEL_CHANGED, again);
    return () => globalThis.removeEventListener?.(DEVICE_MODEL_CHANGED, again);
  }, [refresh]);

  const download = useCallback(() => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setStatus({ kind: 'downloading', received: 0, total: model.bytes });
    void (async () => {
      try {
        const current = await engine();
        await current.download((received, total) => setStatus({ kind: 'downloading', received, total }), controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        abort.current = null;
        await refresh();
        announceChange();
      }
    })();
  }, [engine, model.bytes, refresh]);

  const cancelDownload = useCallback(() => abort.current?.abort(), []);

  const remove = useCallback(async () => {
    setError(null);
    try {
      await (await engine()).remove();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    await refresh();
    announceChange();
  }, [engine, refresh]);

  return { model, status, runtime, error, download, cancelDownload, remove, refresh };
}
