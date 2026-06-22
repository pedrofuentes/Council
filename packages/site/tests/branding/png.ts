import { inflateSync } from "node:zlib";

/**
 * Minimal, dependency-free PNG inspectors for branding asset guards.
 *
 * We only need two facts about generated icons: their pixel dimensions and the
 * colour of the top-left pixel (to distinguish a transparent emblem from one
 * baked onto an opaque background). Pulling in an image library just for that
 * would be a dependency change, so we read the PNG structure directly.
 */

export interface PngSize {
  readonly width: number;
  readonly height: number;
}

/** Read width/height from the IHDR chunk (big-endian, fixed offsets after the 8-byte signature). */
export function pngSize(buffer: Buffer): PngSize {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export type Rgba = readonly [number, number, number, number];

/**
 * Decode the top-left pixel (R, G, B, A) of a non-interlaced 8-bit PNG.
 *
 * At the image origin every PNG row filter predictor (left / up / up-left) is
 * zero, so the first pixel equals the raw bytes immediately after the row's
 * filter-type byte — regardless of which filter the encoder chose. That makes
 * this robust without implementing the full unfilter/scanline pipeline.
 */
export function firstPixelRGBA(buffer: Buffer): Rgba {
  let offset = 8; // skip the PNG signature
  let colorType = 6;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      colorType = data[9] ?? 6;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length; // length(4) + type(4) + data(length) + CRC(4)
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  // colorType: 0 grey, 2 RGB, 4 grey+alpha, 6 RGBA. raw[0] is the row-0 filter byte.
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const grey = raw[1] ?? 0;
  const r = grey;
  const g = channels >= 3 ? (raw[2] ?? 0) : grey;
  const b = channels >= 3 ? (raw[3] ?? 0) : grey;
  const a = channels === 4 ? (raw[4] ?? 255) : channels === 2 ? (raw[2] ?? 255) : 255;
  return [r, g, b, a];
}
