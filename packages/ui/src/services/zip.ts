/**
 * Minimal store-only ZIP (no compression: PDFs are already compressed) for delivering several files
 * as one download on the web (Split). UTF-8 names (general purpose bit 11), no ZIP64 (≤ 4 GiB,
 * ≤ 65535 entries). `readZip` exists for tests and reads only what `zipStore` writes.
 */

let table: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

function safeName(name: string): string {
  const base = [...(name.split(/[\\/]/).pop() ?? '')].filter((c) => c.charCodeAt(0) >= 0x20).join('').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 200) : 'file.pdf';
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => {
    let name = safeName(n);
    if (seen.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let k = 2;
      while (seen.has(`${stem} (${k})${ext}`)) k++;
      name = `${stem} (${k})${ext}`;
    }
    seen.add(name);
    return name;
  });
}

export function zipStore(files: ZipEntry[], date: Date = new Date()): Uint8Array {
  if (files.length > 0xffff) throw new Error('too many files for a ZIP');
  const names = uniqueNames(files.map((f) => f.name));
  const encoder = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  let size = 22;
  const prepared = files.map((f, i) => {
    const name = encoder.encode(names[i]!);
    size += 30 + name.length + f.bytes.byteLength + 46 + name.length;
    return { name, bytes: f.bytes };
  });
  if (size > 0xffffffff) throw new Error('archive too large for a ZIP without ZIP64');
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let pos = 0;
  const offsets: number[] = [];
  const crcs: number[] = [];
  const header = (sig: number) => view.setUint32(pos, sig, true);
  for (const f of prepared) {
    const crc = crc32(f.bytes);
    crcs.push(crc);
    offsets.push(pos);
    header(0x04034b50);
    view.setUint16(pos + 4, 20, true); // version needed
    view.setUint16(pos + 6, 0x0800, true); // UTF-8 names
    view.setUint16(pos + 8, 0, true); // stored
    view.setUint16(pos + 10, time, true);
    view.setUint16(pos + 12, day, true);
    view.setUint32(pos + 14, crc, true);
    view.setUint32(pos + 18, f.bytes.byteLength, true);
    view.setUint32(pos + 22, f.bytes.byteLength, true);
    view.setUint16(pos + 26, f.name.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(f.name, pos + 30);
    pos += 30 + f.name.length;
    out.set(f.bytes, pos);
    pos += f.bytes.byteLength;
  }
  const cdStart = pos;
  prepared.forEach((f, i) => {
    header(0x02014b50);
    view.setUint16(pos + 4, 20, true); // made by
    view.setUint16(pos + 6, 20, true); // needed
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, time, true);
    view.setUint16(pos + 14, day, true);
    view.setUint32(pos + 16, crcs[i]!, true);
    view.setUint32(pos + 20, f.bytes.byteLength, true);
    view.setUint32(pos + 24, f.bytes.byteLength, true);
    view.setUint16(pos + 28, f.name.length, true);
    // extra, comment, disk, internal attrs = 0; external attrs = 0
    view.setUint32(pos + 42, offsets[i]!, true);
    out.set(f.name, pos + 46);
    pos += 46 + f.name.length;
  });
  header(0x06054b50);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, pos - cdStart, true);
  view.setUint32(pos + 16, cdStart, true);
  return out;
}

/** Reads a store-only archive (as written by `zipStore`) through its central directory. */
export function readZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  if (eocd < 0 || view.getUint32(eocd, true) !== 0x06054b50) throw new Error('not a zip');
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('bad central directory');
    const len = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extra = view.getUint16(pos + 30, true);
    const comment = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const name = decoder.decode(zip.subarray(pos + 46, pos + 46 + nameLen));
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    out.push({ name, bytes: zip.slice(start, start + len) });
    pos += 46 + nameLen + extra + comment;
  }
  return out;
}
