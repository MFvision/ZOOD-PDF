# Arabic OCR bench

The pages Scan & OCR was measured on when its reader was rebuilt (2026-10-31,
`packages/ui/models/README.md`):

- `truth/E_commons_qarar193-page1.txt` and `truth/E_commons_tafsir-page2.txt`:
  the text of page 1 of `realworld/E_commons_qarar193_toshiba_estudio_mfp_scan.pdf`
  (a 1977 typed decree from an office copier) and page 2 of
  `realworld/E_commons_tafsir_surat_alnur_pd_scan_p1-3.pdf` (an old printed
  book), typed out by hand; the calligraphic basmala is left out.
- `texts.py`: four office documents (a leave request, a lease, an IT circular,
  a sales report). `make_html.py` lays each out in two Arabic faces from
  `tests/fonts`, `pdf.cjs` prints them with Playwright's Chromium, and
  `degrade.py <out>` makes each page a clean 300 dpi scan, a 200 dpi
  black-and-white office copy and a phone photo, under `<out>/bench/` with its
  truth under `<out>/truth/`.

Measure with `packages/ui/src/ocr/lines.measure.test.ts` (it reads `.pgm`
pages: convert the PNGs with any image tool).
