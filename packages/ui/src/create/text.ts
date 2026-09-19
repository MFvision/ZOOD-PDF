import type { Block, ReadDocument } from './blocks';

/**
 * Plain text: UTF-8 or UTF-16 by a byte order mark; UTF-8 when it reads as
 * UTF-8; else Windows-1256, the code page older Arabic text files are in.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1256').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

/**
 * A text file read into blocks: paragraphs parted by blank lines, each line
 * of a paragraph on a line of its own, and a form feed a new page. Each
 * paragraph takes its direction from its own text.
 */
export function readText(bytes: Uint8Array): ReadDocument {
  const text = decodeText(bytes).replace(/\r\n?/g, '\n');
  const blocks: Block[] = [];
  const pages = text.split('\f');
  pages.forEach((page, k) => {
    if (k > 0) blocks.push({ type: 'pageBreak' });
    for (const paragraph of page.split(/\n[ \t]*\n+/)) {
      const lines = paragraph.replace(/\t/g, '    ').split('\n');
      while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
      if (lines.length === 0) continue;
      blocks.push({ type: 'text', text: lines.map((l) => l.trimEnd()).join('\n'), size: 11, spaceAfter: 8 });
    }
  });
  const first = blocks.find((b) => b.type === 'text');
  const title = first && first.type === 'text' ? first.text.split('\n')[0]!.trim().slice(0, 120) : undefined;
  return { blocks, pictures: [], title: title || undefined, picturesLeftOut: 0, truncated: false };
}
