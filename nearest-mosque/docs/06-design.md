# 6. Design direction

All three concepts keep the same three tabs (Prayer & Qibla, Nearest Mosque, Ask AI) and the gear for
everything else. They differ in layout emphasis, not structure.

| | Quiet Glass (**implemented**) | Daily Focus | Learn Simply |
|---|---|---|---|
| Prayer & Qibla | Atmospheric sky header keyed to the current prayer period, translucent arc with gold time-progress marker, central logo disc that glows when facing the Qibla; content in opaque cards | High-contrast summary bar (next prayer, countdown, Qibla bearing) and six large rows; no imagery | Same as Daily Focus with a short "what is this prayer" line per row |
| Nearest Mosque | Nearest-known card with one Directions button, then a plain list; plot behind a toggle | Dense list with distance first | Same as Quiet Glass |
| Ask AI | Large heading, chips, answer cards with source cards | Search-box-first, answers as compact rows | Very large prompts, reading-led answer with generous type, guided "learn step by step" flows |
| Chrome | Liquid Glass on iOS 26 (tab bar, floating buttons, input field); materials before; Compose translucent header only | Opaque system chrome | Opaque system chrome |

**Taken from the others:** Daily Focus's high-contrast schedule rows (next prayer highlighted, tabular
digits, 48-pt rows) and Learn Simply's large Ask AI prompts, beginner wording and source cards.

## Interaction states (from the written description of the reference clips)

The clips themselves were not available to inspect (see `01-audit.md`). Implemented states:

1. **Home header** (236 pt + status bar): next prayer name, time, live countdown, arc with gold marker.
2. **Expanded header** (360 pt): adds the central disc; opened with the chevron (explicit control) and
   closed with it again; animated with a spring (response 0.42, damping 0.86), instant under Reduce
   Motion.
3. **Compact sticky summary**: appears when the header has scrolled away (scroll-linked, reversible);
   shows event, time, countdown and a small Qibla indicator; its chevron scrolls back and expands.
4. **Qibla detail**: full-screen dial; with a valid true heading the ring turns so N points north and
   the gold arrow sits at the Qibla bearing; guidance "Turn right 35°" / "Facing the Qibla"; one light
   haptic on entering alignment (≤ 5°, leaves at > 8°, only with accuracy ≤ 20°). Without heading it is
   a labelled north-up diagram.

The gold marker means **elapsed time in the current prayer period** (explicitly labelled for screen
readers), not sun position; the disc glow means **alignment**, not decoration.

## Accessibility

* Visible labels on all three tabs; 44 pt (iOS) / 48 dp (Android) minimum targets.
* Dynamic Type / font scale: no fixed-height text containers; the header name scales down before
  truncating.
* VoiceOver/TalkBack: the header is one element ("Dhuhr at 12:36 PM, in 7:05:32"); compass guidance
  is a polite live region; reminder bells announce on/off per prayer; decorative art hidden.
* Reduce Motion: springs replaced by instant updates (dial, header). Reduce Transparency (iOS): glass
  becomes solid secondary background.
* RTL: Arabic and Urdu mirror layout and navigation; compass, plot and arc geometry do not mirror;
  data strings (Latin names/addresses) take their own direction (screenshots in `05-status.md`).
* Colour: navy `#1A4D6E` on white 8.6:1; gold text uses `#8A6A1C` (4.9:1 on white) in light mode.
