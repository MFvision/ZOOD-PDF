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

/** The name of a file made of several: the first one's, and how many more: `report + 2.pdf`. */
export function combinedFileName(names: readonly string[]): string {
  const base = pdfFileName(names[0] ?? '').replace(/\.pdf$/i, '');
  return names.length > 1 ? `${base} + ${names.length - 1}.pdf` : `${base}.pdf`;
}

/**
 * Browsers only. The claim that this also worked under Tauri was wrong: wry
 * registers no download handler, so the link click did nothing at all and the
 * app reported a save that never happened. The desktop path is
 * `savePdfFile` in `core/host-tauri.ts`, chosen in `AppContext.saveDocument`.
 */
export function downloadPdf(bytes: Uint8Array<ArrayBuffer>, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = pdfFileName(name);
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
