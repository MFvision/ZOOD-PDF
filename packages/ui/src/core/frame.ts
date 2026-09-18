/**
 * The body of the desktop host's `core_call`, both ways, as one frame: a u32
 * LE length and the JSON, a u32 LE count of blobs, then each blob as a u32 LE
 * length and its bytes. `encode_frame`/`decode_frame` in the host's
 * `core_bridge.rs` are the Rust side; PDFs travel as raw bytes, never as JSON
 * arrays of numbers.
 */
export interface Frame {
  json: string;
  blobs: ArrayBuffer[];
}

export function encodeFrame(json: string, blobs: readonly ArrayBuffer[]): ArrayBuffer {
  const text = new TextEncoder().encode(json);
  const size = 8 + text.byteLength + blobs.reduce((sum, blob) => sum + 4 + blob.byteLength, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setUint32(at, text.byteLength, true);
  out.set(text, (at += 4));
  view.setUint32((at += text.byteLength), blobs.length, true);
  at += 4;
  for (const blob of blobs) {
    view.setUint32(at, blob.byteLength, true);
    out.set(new Uint8Array(blob), (at += 4));
    at += blob.byteLength;
  }
  return out.buffer;
}

export function decodeFrame(buffer: ArrayBuffer): Frame {
  let at = 0;
  const take = (n: number): ArrayBuffer => {
    if (n < 0 || at + n > buffer.byteLength) throw new Error('E_ARGS: the reply frame is cut short');
    const slice = buffer.slice(at, at + n);
    at += n;
    return slice;
  };
  const length = () => new DataView(take(4)).getUint32(0, true);
  const json = new TextDecoder().decode(take(length()));
  const count = length();
  const blobs: ArrayBuffer[] = [];
  for (let i = 0; i < count; i += 1) blobs.push(take(length()));
  return { json, blobs };
}
