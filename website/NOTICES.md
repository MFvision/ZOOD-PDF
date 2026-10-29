# Third-party material in the website

| What | Licence | Where it is used |
|---|---|---|
| Vazirmatn, © The Vazirmatn Project Authors (`assets/fonts/vazirmatn.woff2`, a subset of `tests/fonts/Vazirmatn-Variable.ttf`) | SIL OFL-1.1 (`assets/fonts/Vazirmatn-OFL.txt`) | body text and the Arabic headline fallback |
| Inter, © The Inter Project Authors (`assets/fonts/inter.woff2`, a subset of `packages/ui/public/fonts/Inter-Variable.ttf`) | SIL OFL-1.1 (`assets/fonts/Inter-OFL.txt`) | English text |
| Noto Naskh Arabic, © Google (outlines of the invented sample lines in `js/desk-arabic.js`) | SIL OFL-1.1 (`assets/fonts/NotoNaskhArabic-OFL.txt`) | the Arabic page on the desk |
| ITF Huwiya Arabic (Indian Type Foundry), ZOOD's headline face | commercial licence held by ZOOD; **not in the repository** | Arabic headlines, only when its file is put in `assets/fonts/licensed/` (ignored by git) |
| ZOOD's logo, mark and pattern (`assets/brand/`, `favicon.svg`, from `scripts/icon/zood/` and the logo pages of ZOOD's brand guidelines) | © ZOOD, all rights reserved; not covered by the repository's licence | the logo, the pattern on the desk, icons |
| App screens (`assets/<lang>/`) | taken from this repository's own web app | device screens |
| Lucide icons, © Lucide Contributors (`js/ring-icons.js`, from the app's `lucide-react` dependency) | ISC | the tool ring's icons |
| App screens and clips (`assets/<lang>/`) are this repository's own web app; the ring scene (`js/ring.js`) is drawn after the app's own ring (`packages/ui/src/quick/`) | this repository's licence | the ring chapter |

## Photographs (`assets/photos/`, the photo scenes in `js/scenes.js`)

From Unsplash, under the Unsplash licence (free to use, no permission needed; credited anyway on each photo and here). Each was downloaded at 2400 px wide and saved as WebP at 900, 1600 and 2400 px (`convert <src>.jpg -resize <w>x -strip -quality 74 <name>-<w>.webp`). The source JPEGs are in git history (commit 8c38714).

| File | Photographer | Unsplash page |
|---|---|---|
| paper-pile | Camilo Rueda López | https://unsplash.com/photos/3CLPBgNuX40 |
| arabic-page | Rawan Yasser | https://unsplash.com/photos/wdPP498hHQ4 |
| desk-man | Amina Atar | https://unsplash.com/photos/yfzRnYRHYLw |
| phone-hand | Quilia | https://unsplash.com/photos/LUgHXvLe_kM |
| desk-woman | Zulfugar Karimov | https://unsplash.com/photos/VxAs4SK2-vw |
| sign-here | Scott Graham | https://unsplash.com/photos/OQMZwNd3ThU |
| tablet-man | Amina Atar | https://unsplash.com/photos/oJ4E_Vm5HaI |
| night-desk | Avtar Singh | https://unsplash.com/photos/odyglVvZv18 |
| hero-library | Tati Odintsova | https://unsplash.com/photos/kZ5nwgLVjqQ |
