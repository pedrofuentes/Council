/**
 * Shared ZIP fixture helpers for ODF extractor tests (T10).
 *
 * Builds minimal in-memory ZIP archives for ODT/ODS/ODP fixtures. The
 * helpers mirror the same byte-level construction used by the PPTX and
 * XLSX extractor tests so the bomb-defense paths exercised here behave
 * identically across all OOXML/ODF formats.
 *
 * The leading underscore in the filename keeps Vitest's collector from
 * picking this file up as a test (vitest.config.ts limits collection to
 * `*.test.ts`).
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  /** "stored" (no compression) by default. "deflate" uses raw DEFLATE. */
  readonly method?: "stored" | "deflate";
  /** Override the uncompressed size reported in headers (for bomb tests). */
  readonly fakeUncompressedSize?: number;
  /** Override the compressed size reported in headers (for bomb tests). */
  readonly fakeCompressedSize?: number;
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? "stored";
    const compressed = method === "deflate" ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const uncompressedSize = entry.fakeUncompressedSize ?? entry.data.length;
    const compressedSize = entry.fakeCompressedSize ?? compressed.length;
    const methodCode = method === "deflate" ? 8 : 0;
    const nameBuf = Buffer.from(entry.name, "utf-8");

    const local = Buffer.alloc(30 + nameBuf.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(methodCode, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    compressed.copy(local, 30 + nameBuf.length);
    localChunks.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(methodCode, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralChunks.push(central);

    offset += local.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

/**
 * Wraps a body fragment in an `office:document-content` envelope with
 * the standard ODF namespaces. Callers supply the `<office:body>...`
 * subtree.
 */
export function odfContentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
    xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
    xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
    xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
    xmlns:office-version="1.2">
  ${body}
</office:document-content>`;
}
