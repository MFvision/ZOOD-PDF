import { isTauriHost, saveFileAs } from '../core/host-tauri';
import type { FileFilter } from '../core/host-tauri';

/**
 * Handing the edited bytes back to the user.
 *
 * Everything runs locally: the bytes go into a Blob, an object URL is created,
 * a link is clicked and the URL is revoked again, so nothing is uploaded and no
 * URL outlives the download.
 */

/** `<original-name>.pdf`, without doubling an extension the name already has. */
export function pdfFileName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'document.pdf';
  return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
}

/** The document's name without its ".pdf": "تقرير" from "تقرير.pdf". */
export function documentStem(name: string): string {
  return pdfFileName(name).replace(/\.pdf$/i, '');
}

/** An export named after its document: `report.pdf` → `report.docx`. */
export function exportFileName(name: string, extension: string): string {
  return `${documentStem(name)}.${extension}`;
}

/** The zip of a document's page images: `report (pages).zip`, `word` in the interface's language. */
export function pagesArchiveName(name: string, word: string): string {
  return `${documentStem(name)} (${word}).zip`;
}

/** The zip of a document split into parts: `report (split).zip`, `word` in the interface's language. */
export function splitArchiveName(name: string, word: string): string {
  return `${documentStem(name)} (${word}).zip`;
}

/** One page image in that zip, numbered to sort in page order: `report-03.png` of twelve. */
export function pageImageName(name: string, page: number, total: number, extension = 'png'): string {
  return `${documentStem(name)}-${String(page).padStart(String(total).length, '0')}.${extension}`;
}

/**
 * The name of a file made of some pages of `name`: `report (2, 4-6).pdf`.
 * Page numbers are one-based, as a person counts them; consecutive runs
 * become ranges.
 */
export function extractedFileName(name: string, pages: readonly number[]): string {
  const base = pdfFileName(name).replace(/\.pdf$/i, '');
  const numbers = [...new Set(pages)].sort((a, b) => a - b).map((p) => p + 1);
  const runs: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j += 1;
    runs.push(j > i ? `${numbers[i]}-${numbers[j]}` : `${numbers[i]}`);
    i = j + 1;
  }
  return `${base} (${runs.join(', ')}).pdf`;
}

/** The name of a smaller copy: `report (compressed).pdf`, whatever the language. */
export function compressedFileName(name: string): string {
  return `${pdfFileName(name).replace(/\.pdf$/i, '')} (compressed).pdf`;
}

/** The name of Compare's report on a file: `report (comparison).html`, whatever the language. */
export function comparisonFileName(name: string): string {
  return `${pdfFileName(name).replace(/\.pdf$/i, '')} (comparison).html`;
}

/** The name of a file made of several: the first one's, and how many more: `report + 2.pdf`. */
export function combinedFileName(names: readonly string[]): string {
  const base = pdfFileName(names[0] ?? '').replace(/\.pdf$/i, '');
  return names.length > 1 ? `${base} + ${names.length - 1}.pdf` : `${base}.pdf`;
}

/**
 * Browsers only. The claim that this also worked under Tauri was wrong: wry
 * registers no download handler, so the link click did nothing at all and the
 * app reported a save that never happened. The desktop path is
 * `saveFileAs` in `core/host-tauri.ts`; `saveBytes` chooses between them.
 */
export function downloadFile(bytes: Uint8Array<ArrayBuffer>, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Revoking in the same task is too early for some browsers to start the
    // download; one turn of the event loop is enough and still bounded.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** `name` in the folder of the file at `path` (a native path), or `name` alone when there is none. */
export function besideFile(path: string | null | undefined, name: string): string {
  if (!path) return name;
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? `${path.slice(0, cut + 1)}${name}` : name;
}

/** `downloadFile` for a PDF, named `<original-name>.pdf`. */
export function downloadPdf(bytes: Uint8Array<ArrayBuffer>, name: string): void {
  downloadFile(bytes, pdfFileName(name), 'application/pdf');
}

/** What a file is: its media type for a download, its kind for the desktop save panel. */
export interface FileKind {
  mime: string;
  filter: FileFilter;
}

/**
 * Gives the person a file: the native save panel on desktop, a download in a
 * browser. `false` when they cancelled the panel, which is not a failure.
 */
export async function saveBytes(bytes: Uint8Array<ArrayBuffer>, name: string, kind: FileKind): Promise<boolean> {
  if (isTauriHost()) return saveFileAs(bytes, name, kind.filter);
  downloadFile(bytes, name, kind.mime);
  return true;
}
