// A stand-in for the desktop app's native side, so the desktop window can be
// pictured in a browser (scripts/support/make-shots.mjs). It answers only what
// the window asks for at start and in Settings; nothing here reaches a device.
import { readFileSync } from 'node:fs';

const qr = readFileSync(new URL('./fixtures/remote-qr.svg', import.meta.url), 'utf8');

const remote = {
  running: true,
  url: 'https://192.168.1.20:47321/',
  qr,
  codeUntil: Date.now() + 10 * 60_000,
  address: '192.168.1.20',
  phones: [],
  remembered: [],
  pcControl: false,
  pcControlAvailable: true,
  clipboard: false,
  clipboardAvailable: true,
};

/** The script put in the page before the app starts. */
export function desktopHost(name, files = [], extra = {}) {
  const answers = {
    system_user_name: name,
    ai_memory_bytes: 16e9,
    ai_runtime: 'cpu',
    ai_model_status: { state: 'missing' },
    remote_status: remote,
    remote_start: remote,
    core_version: '0.4.4',
    core_engine: 'native',
    shell_menu_state: { kind: 'registry', on: true },
    ring_settings: { ring: true, background: true, scale: 1, shortcut: 'CommandOrControl+Alt+Z', dragKey: 'any' },
    ask_settings: { enabled: true, shortcut: 'CommandOrControl+Shift+Space', sees: true, taps: true, tapKey: 'Control', tapToType: true, tapSpeaks: true, glow: true },
    ask_access: { applies: false, accessibility: true, screen: true, microphone: 'allowed', input: true },
    presence_settings: { bubble: true, lang: 'ar' },
    quick_job: { tool: null, files },
    ring_take: files,
    ring_phone: false,
    ...extra,
  };
  return `(() => {
    const answers = ${JSON.stringify(answers)};
    answers.remote_status.codeUntil = Date.now() + 600000;
    // Windows: the keys and switches shown are the Windows ones.
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' });
    const callbacks = new Map();
    const listeners = new Map();
    let next = 1;
    // The picture recipes send the host's events with this.
    globalThis.__shotEmit = (event, payload) => {
      for (const handler of listeners.get(event) ?? []) callbacks.get(handler)?.({ event, id: 0, payload });
    };
    globalThis.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback(callback) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      convertFileSrc: (path) => path,
      async invoke(cmd, args) {
        if (cmd === 'plugin:event|listen') listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
        return cmd in answers ? answers[cmd] : null;
      },
    };
  })();`;
}
