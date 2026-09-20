import { createPdfiumEngine } from '@embedpdf/engines/pdfium-worker-engine';
import { PdfPageFlattenFlag, PdfPageFlattenResult, PdfPermissionFlag, buildPermissions } from '@embedpdf/models';
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';

/**
 * PDFium, on its own, for the batch steps Warraq's core does not do itself:
 * Protect (the standard security handler, written by PDFium as EmbedPDF's
 * own Protect does) and Flatten (form fields and comments drawn into the
 * page). The same PDFium EmbedPDF's view runs, from the same bundled
 * WebAssembly, in a worker of its own — started only when a batch has such
 * a step, and stopped when the batch ends.
 */

export interface ProtectSpec {
  /** Asked for to open the file; empty for none (then only the permissions are set). */
  openPassword: string;
  /** Asked for to change the permissions; one is made up when empty, so they hold. */
  ownerPassword: string;
  allowPrint: boolean;
  allowCopy: boolean;
  allowChange: boolean;
}

export interface PdfiumTools {
  /** The file with the password and permissions of `spec`, written whole. */
  protect(bytes: ArrayBuffer, password: string | undefined, spec: ProtectSpec): Promise<ArrayBuffer>;
  /** Every page's form fields and comments drawn into the page, written whole; how many pages changed. */
  flatten(bytes: ArrayBuffer, password: string | undefined): Promise<{ bytes: ArrayBuffer; pages: number }>;
  stop(): Promise<void>;
}

let opened = 0;

/** The permissions `spec` grants, as PDFium's flags. */
export function permissionsOf(spec: ProtectSpec): number {
  const flags: PdfPermissionFlag[] = [PdfPermissionFlag.ExtractForAccessibility];
  if (spec.allowPrint) flags.push(PdfPermissionFlag.Print, PdfPermissionFlag.PrintHighQuality);
  if (spec.allowCopy) flags.push(PdfPermissionFlag.CopyContents);
  if (spec.allowChange) {
    flags.push(
      PdfPermissionFlag.ModifyContents,
      PdfPermissionFlag.ModifyAnnotations,
      PdfPermissionFlag.FillForms,
      PdfPermissionFlag.AssembleDocument,
    );
  }
  return buildPermissions(...flags);
}

/** An owner password nobody will type, for a file given only an open password or only permissions. */
function madeUpOwner(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function startPdfium(): PdfiumTools {
  const engine = createPdfiumEngine(new URL(pdfiumWasmUrl, globalThis.location?.href ?? '/').href, {
    // Nothing is fetched from anywhere: no fallback fonts from a CDN.
    fontFallback: null,
  });
  const open = async (bytes: ArrayBuffer, password: string | undefined) => {
    opened += 1;
    return engine
      .openDocumentBuffer({ id: `batch-${opened}`, content: bytes.slice(0) }, password === undefined ? {} : { password })
      .toPromise();
  };
  return {
    async protect(bytes, password, spec) {
      const doc = await open(bytes, password);
      try {
        const owner = spec.ownerPassword || madeUpOwner();
        const done = await engine.setDocumentEncryption(doc, spec.openPassword, owner, permissionsOf(spec)).toPromise();
        if (!done) throw new Error('E_PROTECT: PDFium did not set the password');
        return await engine.saveAsCopy(doc).toPromise();
      } finally {
        await engine.closeDocument(doc).toPromise().catch(() => undefined);
      }
    },
    async flatten(bytes, password) {
      const doc = await open(bytes, password);
      try {
        let pages = 0;
        for (const page of doc.pages) {
          const result = await engine.flattenPage(doc, page, { flag: PdfPageFlattenFlag.Display }).toPromise();
          if (result === PdfPageFlattenResult.Success) pages += 1;
        }
        return { bytes: await engine.saveAsCopy(doc).toPromise(), pages };
      } finally {
        await engine.closeDocument(doc).toPromise().catch(() => undefined);
      }
    },
    async stop() {
      await engine.destroy().toPromise().catch(() => undefined);
    },
  };
}
