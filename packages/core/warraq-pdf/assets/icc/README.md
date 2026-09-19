# ICC profiles bundled with Warraq's core

Both come from Clinton Ingram's Compact-ICC-Profiles
(https://github.com/saucecontrol/Compact-ICC-Profiles), released under
**CC0 1.0 Universal** (`LICENSE-CC0.txt`). They were copied byte for byte from
crates already in the core's dependency graph, which ship the same files under
the same licence: `sRGB-v2-magic.icc` from `krilla` 0.8.2 (`icc/`) and
`CGATS001Compat-v2-micro.icc` from `hayro-interpret` 0.7.0 (`assets/`).

| File | Class | Space | Used for |
|---|---|---|---|
| `sRGB-v2-magic.icc` (736 bytes, ICC v2.1) | monitor (`mntr`) | RGB | The PDF/A output intent (sRGB IEC 61966-2.1), and `DefaultRGB` for PDF/X |
| `CGATS001Compat-v2-micro.icc` (8464 bytes, ICC v2.1) | input (`scnr`) | CMYK | `DefaultCMYK`: device CMYK made device-independent (CGATS TR 001, SWOP) in a PDF/A file whose output intent is sRGB |

The CMYK profile describes CMYK to the connection space only (no `B2A0`), which
is all an `ICCBased` colour space needs. It cannot be a PDF/X output intent,
which must be an output (`prtr`) profile: PDF/X-4 takes the printer's profile
from the person converting.
