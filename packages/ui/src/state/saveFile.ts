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
 * TODO(desktop): under Tauri this should offer a native save dialog through the
 * host instead of a browser download. The web path works there today because
 * the webview handles object URLs, so the feature is not blocked on it.
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
