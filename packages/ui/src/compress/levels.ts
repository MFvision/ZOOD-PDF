/**
 * Compress's three choices, from none of the images touched to the smallest
 * file: what `compress.file` is asked for. Shared by the Compress panel and
 * the batch's Compress step.
 */
export const COMPRESS_LEVELS = {
  lossless: {},
  balanced: { imageDpi: 150, jpegQuality: 75 },
  smallest: { imageDpi: 96, jpegQuality: 60 },
} as const;

export type CompressLevel = keyof typeof COMPRESS_LEVELS;
