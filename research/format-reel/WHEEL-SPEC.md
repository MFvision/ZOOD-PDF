# Format wheel: frame-by-frame study (Filee reel, 60 s)

Source frames: `f_NNN.jpg` (t = (N-1) x 0.5 s). Close-up sheets: `wheel.jpg` (0-2 s, 15-19 s),
`open.jpg` (2-4 s, 8-10 s, 12-14 s), `batchwheel.jpg` (33-37 s).

## A. Full circle: one file (0-22 s, f_001-f_045)

1. **Trigger**: hold Ctrl and start dragging a file (here `trip.jpg`) in the file manager. No app window
   opens; the wheel appears *at the cursor*, over the folder.
2. **Look**: a full ring about 250 px across in dark translucent glass (blurred backdrop, thin dividers).
   It has 8 wedges with bold white labels and a small grey sub-label giving the output type
   ("Trace to SVG" / "SVG", "Half size" / "JPG"). The dragged file's thumbnail stays under the cursor.
3. **Wedges, clockwise from the top**: PDF · Trace to SVG · **Formats (Group of 3)** · TIFF · BMP · ICO ·
   Half size (JPG) · Line art to SVG. The wheel mixes *actions* (resize, vectorise) with *targets*.
   Only options that fit the file type are shown.
4. **Hub (centre)**: a circle showing the count and type, "1 × JPG", with a hint underneath:
   - while the cursor is still on the hub: hint "Drop here to cancel" and a **red** hub tint (f_001-f_003);
   - after the cursor moves off it: "Move outward to choose · Tab ↻ back";
   - once a target is armed: "Drop → Formats · WEBP · Tab ↻ back" (a live preview of what the drop will do).
5. **Groups / second ring**: hovering the "Formats" wedge fills it **solid purple**, and an outer
   arc of smaller wedges fans out beside it: PNG · JPG · WEBP. Dragging *outward* onto one of them arms it,
   and that small wedge turns purple too. Tab steps back out of the group.
6. **Drop**: the wheel disappears at once. The new file `trip.webp` appears **next to the original** in
   the same folder, with a circular progress ring on its icon (37% → 95% → done, f_042-f_046).
   There is no dialog, no save-as and no upload.

## B. Half circle: several files (33-37 s, f_067-f_075)

1. Select 3 documents (DOCX, PPTX, XLSX) and drag them with Ctrl held.
2. A **half-circle fan opens above the cursor**: 3 large light wedges, HTML · PDF · DOCX, showing only
   the formats that all the selected files share. It sits on a hub reading "3 files · Esc to close", with a purple
   count badge "3" on the dragged stack.
3. Hovering PDF fills that wedge purple.
4. On drop, the hub itself **turns into a progress ring** (6% → 99%). Then a green check appears with
   "3 files converted", and the PDFs appear next to the originals.

## C. Rules to copy
- Open at the cursor, centred on the drag point. Never open a window.
- The centre is always the cancel zone (red while hovered). Esc closes; Tab goes back one level.
- One file gets the full circle (many options). Several files get a half circle above the cursor
  (fewer, shared options).
- Options that are too many to show go into a "Group of N" wedge that opens a second outer ring.
- The hub always says what will happen ("Drop → PDF").
- The result goes next to the source; progress shows on the icon or hub, and success is a check.
- Palette: dark glass ring, one accent colour (purple) for hover/armed, white labels, grey sub-labels.

## D. Owner feedback to apply in the same fix (2026-10-24, see `owner-about-dialog.png`)
The About ZOOD PDF dialog currently says *"Everything runs locally in your browser"*. That is wrong and
undersells the product. ZOOD PDF is a full **desktop app** (not browser-based) with many tools and
built-in, on-device AI (local models), plus optional cloud AI. Mohammed does not like the current
explanation. The About text should describe it as the complete PDF solution: an installed app,
offline by default, with tools and local AI, where nothing leaves the device unless the user chooses.
