import sharp from "sharp";

export interface CompressResult {
  buffer: Buffer;
  originalKb: number;
  finalKb: number;
  width: number;
  height: number;
}

/**
 * Compress an image to fit under targetKb by stepping quality down first,
 * then shrinking dimensions. Govt portals typically want small JPEGs
 * (50-200KB), so JPEG output is fixed.
 */
export async function compressToTarget(input: Buffer, targetKb: number): Promise<CompressResult> {
  const meta = await sharp(input).metadata();
  let width = meta.width ?? 1200;
  let quality = 85;

  let out = input;
  for (let i = 0; i < 20; i++) {
    out = await sharp(input)
      .rotate() // respect EXIF orientation from phone cameras
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= targetKb * 1024) break;
    if (quality > 40) {
      quality -= 10;
    } else {
      width = Math.max(200, Math.round(width * 0.8));
      if (width === 200) break;
    }
  }

  const finalMeta = await sharp(out).metadata();
  return {
    buffer: out,
    originalKb: Math.round(input.length / 1024),
    finalKb: Math.round(out.length / 1024),
    width: finalMeta.width ?? 0,
    height: finalMeta.height ?? 0,
  };
}
