/**
 * A short buzz, when the phone can and may: browsers refuse (and complain)
 * until the person has touched the page, so a file caught before any tap
 * stays silent rather than logging an error.
 */
export function buzz(pattern: number | number[] = 8): void {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate?.(pattern);
  } catch {
    // Not every phone can.
  }
}
