# Scan & OCR models kept in the repository

## `ppocrv5-mobile-det.onnx` — the line finder

PaddleOCR's PP-OCRv5 mobile text detection model, Apache-2.0
(<https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det>), converted from
Paddle's own format to ONNX:

```
pip install paddlepaddle paddle2onnx          # Python 3.12
paddle2onnx --model_dir PP-OCRv5_mobile_det --model_filename inference.json \
  --params_filename inference.pdiparams --save_file det.onnx --opset_version 14
```

- `inference.pdiparams` sha256 `afa1820cb16c1fd0dad589d0f8b389139061c1ef6d68019685fd07be997dda5b`
- `ppocrv5-mobile-det.onnx` sha256 `6bdf743af375b13fbbeeb47a91a40063af5bfb7a7f197f6df8cb990dc827e5d6`

Served as `ocr/lines.onnx` (`vite/ocrModels.ts`) and run by onnxruntime-web
in its own worker (`src/ocr/detect.worker.ts`). Input: the page, RGB,
ImageNet-normalized, longest side 1600 in multiples of 32; output: a map of
the probability that each pixel is text, turned into line boxes by
`src/ocr/lines.ts`.

## Why (measured 2026-10-31)

Thirty pages with their true text: the corpus scans, two real scans from
`tests/corpus/arabic/realworld` (a 1977 typed decree from an office copier,
and a page of an old printed book, typed out by hand), and 24 pages made
from four office documents (a leave request, a lease, an IT circular, a
sales report) in eight Arabic faces, each as a clean 300 dpi scan, a 200 dpi
black-and-white office copy and a phone photo (the pages and how to make
them: `tests/corpus/arabic/ocr-bench/`). Share of the words read, by
`src/ocr/lines.measure.test.ts` (tesseract.js and onnxruntime-web in Node, the
same models the app ships):

| | Before: Tesseract finds the lines, Arabic + English together | Now: lines found, each evened out, Arabic first |
|---|---|---|
| Clean scans (8) | 88 % | 92 % |
| Office copies (8) | 80 % | 88 % |
| Phone photos (8) | 37 % | 87 % |
| Invoice, 200 dpi black and white | 60 % | 87 % |
| Shadowed and stained scan | 69 % | 89 % |
| Old printed book | 54 % | 64 % |
| 1977 typed decree | 34 % | 34 % (read whole: see below) |

In the app, through the interface (`apps/web/e2e/ocr.spec.ts`): the stained
scan 59 % → 85 % with no cleanup ticked, the invoice 67 % → 83 %.

A page read line by line with a mean confidence under 60 % is read whole too
and the better reading kept (a page turned 8° that the straightening could
not measure fell to 2 % line by line; read whole, 64 %).

English letters invented on Arabic pages (native Tesseract, the 30 pages):
25–196 a page before, none after, since English is read only where the
Arabic reading failed. In the app on the corpus's Arabic page with English
names in it, at most a misread word ("PDE" for PDF).

Tried and not taken:
- Tesseract's float `tessdata_best` Arabic model read clean scans better (91 %)
  but tesseract.js's WebAssembly cores cannot run float models (they abort on
  `DotProductSSE`).
- PaddleOCR's own Arabic recognizer (PP-OCRv5): good on photos, worse than
  Tesseract on print (39 % of the old book) and glues words together.
- Local vision models through llama.cpp (PaddleOCR-VL 1.6, Qari-OCR 0.3,
  Qwen3-VL 2B, Nuqta 0.8B): 1.5–5 minutes a page on four CPU cores, and no
  better on the hard pages (Qari: 42 % of the decree with invented English;
  PaddleOCR-VL: 43 % with invented words).
