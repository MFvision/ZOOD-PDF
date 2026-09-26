import catalogue from './models.json';

/**
 * The models "On this device" can run: Qwen2.5-Instruct in GGUF (Apache-2.0),
 * from Qwen's own repository on Hugging Face. Nothing here is in the app: a
 * model is fetched only when the person presses the download button, is
 * checked against the size and SHA-256 written in `models.json` — the ones
 * Hugging Face publishes for the file — and is kept on this device. The
 * desktop host reads the same file (`src-tauri/src/ai.rs`).
 */
export type DeviceModelId = 'qwen2.5-1.5b' | 'qwen2.5-0.5b';

export interface DeviceModel {
  id: DeviceModelId;
  name: string;
  file: string;
  repo: string;
  url: string;
  sha256: string;
  bytes: number;
  /** The memory a machine should have to run it comfortably. */
  ramGiB: number;
}

export const DEVICE_MODELS: readonly DeviceModel[] = catalogue.models as DeviceModel[];
export const MODEL_LICENCE = catalogue.licence;
export const MODEL_LICENCE_URL = catalogue.licenceUrl;
/** What the web page's `connect-src` allows for that one download: Hugging Face and its CDN. */
export const MODEL_HOSTS: readonly string[] = catalogue.hosts;

export function deviceModel(id: string): DeviceModel {
  return DEVICE_MODELS.find((model) => model.id === id) ?? DEVICE_MODELS[0]!;
}

/**
 * The model to offer: the 1.5B on a computer with 8 GB or more, the 0.5B on
 * a smaller one, and always the 0.5B in a browser, where the model runs in
 * WebAssembly on the CPU and a larger one would be too slow to be useful.
 * `memoryGiB` is null where the machine does not say.
 */
export function defaultModelFor(memoryGiB: number | null, inBrowser: boolean): DeviceModel {
  if (inBrowser) return deviceModel('qwen2.5-0.5b');
  if (memoryGiB !== null && memoryGiB < 7.5) return deviceModel('qwen2.5-0.5b');
  return deviceModel('qwen2.5-1.5b');
}

/** "1.0 GB", "470 MB": the size a person is asked to download. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/** The checksum as shown: its first and last characters, enough to compare with the repository's page. */
export function shortChecksum(sha256: string): string {
  return `${sha256.slice(0, 12)}…${sha256.slice(-8)}`;
}
