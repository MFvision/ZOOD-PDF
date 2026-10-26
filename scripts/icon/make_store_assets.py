#!/usr/bin/env python3
"""Makes the Microsoft Store package's pictures from the app's own icons.

Run from the repository root: python3 scripts/icon/make_store_assets.py
Writes apps/desktop/src-tauri/windows/store/Assets/ (AppxManifest.xml names
them; makepri indexes the scale and target-size copies). Needs Pillow.

- The app's tile and taskbar pictures come from icons/icon.png.
- PdfDocument.* is the icon a PDF gets in Explorer once ZOOD PDF opens PDFs,
  the same document icon the installer copy uses (resources/windows/
  pdf-document.ico, made by make_pdf_document_icon.py).
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
TAURI = ROOT / "apps/desktop/src-tauri"
OUT = TAURI / "windows/store/Assets"
TARGET_SIZES = (16, 24, 32, 48, 256)


def resized(picture: Image.Image, size: int) -> Image.Image:
    return picture.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon = Image.open(TAURI / "icons/icon.png").convert("RGBA")
    for name, size in (("Square44x44Logo", 44), ("Square150x150Logo", 150), ("StoreLogo", 50)):
        resized(icon, size).save(OUT / f"{name}.png")
        resized(icon, size * 2).save(OUT / f"{name}.scale-200.png")
    # The taskbar and Start's list: unplated, at the sizes Windows asks for.
    for size in TARGET_SIZES:
        picture = resized(icon, size)
        picture.save(OUT / f"Square44x44Logo.targetsize-{size}.png")
        picture.save(OUT / f"Square44x44Logo.targetsize-{size}_altform-unplated.png")

    document = Image.open(TAURI / "resources/windows/pdf-document.ico")
    for size in TARGET_SIZES:
        document.size = (size, size)
        document.load()
        document.convert("RGBA").save(OUT / f"PdfDocument.targetsize-{size}.png")
    document.size = (48, 48)
    document.load()
    document.convert("RGBA").save(OUT / "PdfDocument.png")


if __name__ == "__main__":
    main()
