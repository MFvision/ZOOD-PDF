/**
 * The on-device model's window, in tokens, for this machine. Qwen2.5 reads
 * far more than the 4,096 tokens it was first given here; what limits it is
 * the machine: the key-value cache grows with the window, and so does the
 * time the prompt takes to read before the first word of an answer. Measured
 * on an 8 GB Mac (docs/STATUS.md, "The assistant"): 8,192 tokens fit with
 * room to spare, so that is what a computer with 8 GB or more gets; a smaller
 * one, and every browser (the model runs in WebAssembly there, on the CPU,
 * inside the tab's memory), keeps 4,096.
 */
export const SMALL_CONTEXT = 4096;
export const LARGE_CONTEXT = 8192;

export function contextTokensFor(memoryGiB: number | null, inBrowser: boolean): number {
  if (inBrowser) return SMALL_CONTEXT;
  if (memoryGiB === null || memoryGiB < 7.5) return SMALL_CONTEXT;
  return LARGE_CONTEXT;
}

/** Tokens kept for the answer in a window of `context` tokens. */
export function replyTokensFor(context: number): number {
  return Math.min(1024, Math.floor(context / 4));
}

/**
 * Tokens the rules, the tags around the material and the request itself
 * take, kept apart from the material's share. Counted on the real prompts:
 * the rules are about 190 tokens, a request with its scaffolding under 150.
 */
export const PROMPT_OVERHEAD_TOKENS = 400;

/** Tokens of material — document text, summaries, earlier turns — one request can carry. */
export function materialTokensFor(context: number): number {
  return Math.max(256, context - replyTokensFor(context) - PROMPT_OVERHEAD_TOKENS);
}

/**
 * Characters a token is worth when there is too little text to measure:
 * under the lowest the real tokenizer gave for pages of the corpus (1.21, a
 * law set in a legacy Arabic encoding), so a guess errs toward sending less,
 * never toward overflowing the window.
 */
export const SAFE_CHARS_PER_TOKEN = 1.1;

/**
 * About how many tokens `text` is, where the engine cannot count (the
 * browser's): by the kind of each character, with figures taken from the
 * real tokenizer on the corpus (docs/STATUS.md). An Arabic letter is about
 * half a token, but every vowel mark, every digit and every presentation
 * form is one of its own — which is why a vowelled or a legacy-encoded text
 * costs twice what its length suggests.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0x20 || code === 0x0a || code === 0x09) tokens += 0.25;
    else if (code >= 0x30 && code <= 0x39) tokens += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) tokens += 0.25;
    else if ((code >= 0x064b && code <= 0x065f) || code === 0x0670 || code === 0x0640) tokens += 1;
    else if (code >= 0x0660 && code <= 0x0669) tokens += 1;
    else if (code >= 0x0600 && code <= 0x06ff) tokens += 0.45;
    else if (code >= 0xfb50 && code <= 0xfeff) tokens += 1;
    else tokens += 0.8;
  }
  return Math.ceil(tokens);
}

/**
 * Tokens of material one turn of the chat carries at most, by where the
 * model runs. The window bounds what can be read at once; this bounds the
 * wait before the first word of an answer, which is the time the prompt
 * takes to read: about 400 tokens a second on the Mac's graphics processor
 * and a fraction of that on a processor alone (docs/STATUS.md). The
 * analysis is not bound by it — it reads every page once, whatever the size
 * of its steps — only each answer is.
 */
export function turnTokensFor(runtime: string): number {
  if (runtime === 'metal') return 4000;
  if (runtime === 'cpu' || runtime === 'wasm' || runtime === 'wasm-threads') return 2000;
  return Number.POSITIVE_INFINITY;
}
