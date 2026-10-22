/** What a report or an idea may carry, so neither grows without bound. */
export const LIMITS = {
  text: 4000,
  contact: 200,
  logLines: 200,
  logChars: 24_000,
  /** The picture, after it is made smaller: a JPEG this many bytes at most. */
  pictureBytes: 1_500_000,
  pictureSide: 1600,
  ideaTitle: 120,
  ideaBody: 1000,
  /** Tickets kept on this device, newest first. */
  tickets: 50,
} as const;
