// The real Tauri APIs handed to the shared UI's host bridge (packages/ui/src/services/host-tauri.ts).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import type { TauriApis } from '@zood/ui/src/services/host-tauri';

export const tauriApis: TauriApis = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) => listen(event, handler),
  openDialog: (options) => open(options),
  saveDialog: (options) => save(options),
  readFile: (path) => readFile(path),
  // `plugin:fs|write_file` — WKWebView ignores <a download>, so saving must go through Rust.
  writeFile: (path, bytes) => writeFile(path, bytes),
};
