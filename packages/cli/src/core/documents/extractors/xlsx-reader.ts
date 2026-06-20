/**
 * Dependency-light `.xlsx` reader built on `yauzl` (ZIP) and
 * `fast-xml-parser` (XML).
 *
 * An `.xlsx` file is a ZIP container of XML parts. This module reads the
 * relevant parts directly so the runtime no longer depends on the
 * unmaintained `exceljs` package (which pulled in six deprecated
 * transitive dependencies). It deliberately does the minimum the XLSX
 * extractor needs: turn bytes into one entry per worksheet, in document
 * order, with every cell already stringified using the exact semantics
 * the previous exceljs-based extractor relied on.
 *
 * Out of scope (kept in `xlsx.ts`): the yauzl zip-bomb preflight,
 * markdown rendering, and the DoS size/row/cell limits.
 *
 * Cell stringification semantics (matching the previous `cellToString`):
 *   - shared string / inline string -> the text (rich-text runs joined)
 *   - number -> `String(Number(raw))`
 *   - boolean -> "true" / "false"
 *   - date-formatted number -> the serial converted to a `Date` (1900
 *     system, including the 1900 leap-year bug) then `.toISOString()`
 *   - formula -> its cached `<v>` value
 *   - error -> the error code string
 *
 * Encrypted workbooks are OLE/CFB compound documents (not ZIPs) that
 * carry an `EncryptedPackage` stream; these throw `XlsxEncryptedError`.
 * Any other failure to parse throws `XlsxParseError`, so the extractor
 * can map them to `encrypted-document` vs `corrupt-document`.
 */
import * as yauzl from "yauzl";
import { XMLParser } from "fast-xml-parser";

/** Thrown when the buffer is an encrypted (password-protected) workbook. */
export class XlsxEncryptedError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "XlsxEncryptedError";
  }
}

/** Thrown when the buffer cannot be parsed as an `.xlsx` workbook. */
export class XlsxParseError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "XlsxParseError";
  }
}

export interface XlsxSheet {
  readonly name: string;
  /**
   * Rows of stringified cells in document order. Each row spans column 0
   * through its last populated column (interior gaps are `""`); trailing
   * empty columns are not padded — the caller aligns rows to the header.
   */
  readonly rows: string[][];
}

/** OLE2/CFB compound-document signature (encrypted xlsx and legacy .xls). */
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalise fast-xml-parser's "single | array | absent" into an array. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Extract the text of a `<t>`-style node. fast-xml-parser yields a bare
 * string when the element has no attributes and a `{ "#text": ... }`
 * object when it carries `xml:space="preserve"`.
 */
function nodeText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (isRecord(node)) {
    const text = node["#text"];
    if (typeof text === "string") {
      return text;
    }
    if (typeof text === "number" || typeof text === "boolean") {
      return String(text);
    }
  }
  return "";
}

/** Concatenate the `<t>` runs of a shared-string `<si>` or inline `<is>`. */
function richText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!isRecord(node)) {
    return "";
  }
  if (node.r !== undefined) {
    return asArray(node.r)
      .map((run) => (isRecord(run) ? nodeText(run.t) : ""))
      .join("");
  }
  return nodeText(node.t);
}

function readZipEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipFile) => {
      if (err !== null && err !== undefined) {
        reject(err);
        return;
      }
      if (zipFile === undefined) {
        reject(new Error("yauzl returned no zip file"));
        return;
      }
      const entries = new Map<string, Buffer>();
      zipFile.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null && streamErr !== undefined) {
            reject(streamErr);
            return;
          }
          if (stream === undefined) {
            reject(new Error("yauzl returned no read stream"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipFile.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zipFile.on("end", () => resolve(entries));
      zipFile.on("error", reject);
      zipFile.readEntry();
    });
  });
}

function parseSharedStrings(entries: Map<string, Buffer>): string[] {
  const raw = entries.get("xl/sharedStrings.xml");
  if (raw === undefined) {
    return [];
  }
  const doc = parser.parse(raw.toString("utf-8")) as unknown;
  const sst = isRecord(doc) ? doc.sst : undefined;
  if (!isRecord(sst)) {
    return [];
  }
  return asArray(sst.si).map((si) => richText(si));
}

/**
 * Builtin number-format ids that always denote dates or times
 * (14–22 and 45–47).
 */
function isBuiltinDateFormat(numFmtId: number): boolean {
  return (numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47);
}

/**
 * Heuristic date detection for custom format codes: strip quoted
 * literals, escaped characters, bracketed sections and the colour/locale
 * tokens, then look for any date/time placeholder character.
 */
function isCustomDateFormat(formatCode: string): boolean {
  const stripped = formatCode
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(stripped);
}

interface StyleInfo {
  /** Per-cell-xf flag: does style index `s` denote a date/time format? */
  readonly dateFlags: readonly boolean[];
}

function parseStyles(entries: Map<string, Buffer>): StyleInfo {
  const raw = entries.get("xl/styles.xml");
  if (raw === undefined) {
    return { dateFlags: [] };
  }
  const doc = parser.parse(raw.toString("utf-8")) as unknown;
  const styleSheet = isRecord(doc) ? doc.styleSheet : undefined;
  if (!isRecord(styleSheet)) {
    return { dateFlags: [] };
  }

  const customFormats = new Map<number, string>();
  const numFmtsNode = styleSheet.numFmts;
  if (isRecord(numFmtsNode)) {
    for (const numFmt of asArray(numFmtsNode.numFmt)) {
      if (!isRecord(numFmt)) {
        continue;
      }
      const id = Number(numFmt["@_numFmtId"]);
      const code = numFmt["@_formatCode"];
      if (Number.isFinite(id) && typeof code === "string") {
        customFormats.set(id, code);
      }
    }
  }

  const cellXfs = isRecord(styleSheet.cellXfs) ? styleSheet.cellXfs.xf : undefined;
  const dateFlags = asArray(cellXfs).map((xf) => {
    if (!isRecord(xf)) {
      return false;
    }
    const numFmtId = Number(xf["@_numFmtId"]);
    if (!Number.isFinite(numFmtId)) {
      return false;
    }
    if (isBuiltinDateFormat(numFmtId)) {
      return true;
    }
    const code = customFormats.get(numFmtId);
    return code !== undefined && isCustomDateFormat(code);
  });

  return { dateFlags };
}

interface SheetRef {
  readonly name: string;
  readonly path: string;
}

/** Resolve a workbook-relative relationship target to a full zip path. */
function resolveTarget(target: string): string {
  const normalized = target.replace(/^\//, "").replace(/^xl\//, "");
  return `xl/${normalized}`;
}

function parseWorkbook(entries: Map<string, Buffer>): SheetRef[] {
  const workbookRaw = entries.get("xl/workbook.xml");
  if (workbookRaw === undefined) {
    throw new XlsxParseError("workbook.xml is missing from the archive");
  }
  const doc = parser.parse(workbookRaw.toString("utf-8")) as unknown;
  const workbook = isRecord(doc) ? doc.workbook : undefined;
  const sheetsNode = isRecord(workbook) ? workbook.sheets : undefined;
  if (!isRecord(sheetsNode)) {
    return [];
  }

  const relTargets = parseRelationships(entries);

  const refs: SheetRef[] = [];
  asArray(sheetsNode.sheet).forEach((sheet, index) => {
    if (!isRecord(sheet)) {
      return;
    }
    const name = typeof sheet["@_name"] === "string" ? sheet["@_name"] : "";
    const rid = sheet["@_r:id"];
    let target: string | undefined;
    if (typeof rid === "string") {
      target = relTargets.get(rid);
    }
    target ??= `worksheets/sheet${String(index + 1)}.xml`;
    refs.push({ name, path: resolveTarget(target) });
  });
  return refs;
}

function parseRelationships(entries: Map<string, Buffer>): Map<string, string> {
  const raw = entries.get("xl/_rels/workbook.xml.rels");
  const targets = new Map<string, string>();
  if (raw === undefined) {
    return targets;
  }
  const doc = parser.parse(raw.toString("utf-8")) as unknown;
  const relationships = isRecord(doc) ? doc.Relationships : undefined;
  if (!isRecord(relationships)) {
    return targets;
  }
  for (const rel of asArray(relationships.Relationship)) {
    if (!isRecord(rel)) {
      continue;
    }
    const id = rel["@_Id"];
    const target = rel["@_Target"];
    if (typeof id === "string" && typeof target === "string") {
      targets.set(id, target);
    }
  }
  return targets;
}

/** Convert a cell reference's column letters (e.g. "B" in "B3") to a 0-based index. */
function columnIndex(ref: string): number {
  let index = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      index = index * 26 + (code - 64);
    } else if (code >= 97 && code <= 122) {
      index = index * 26 + (code - 96);
    } else {
      break;
    }
  }
  return index - 1;
}

function serialToIso(serial: number): string {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 86_400_000).toISOString();
}

function cellToString(
  cell: Record<string, unknown>,
  sharedStrings: readonly string[],
  dateFlags: readonly boolean[],
): string {
  const type = cell["@_t"];

  if (type === "s") {
    const index = Number(nodeText(cell.v));
    return Number.isFinite(index) ? (sharedStrings[index] ?? "") : "";
  }
  if (type === "inlineStr") {
    return richText(cell.is);
  }
  if (type === "str") {
    return nodeText(cell.v);
  }
  if (type === "b") {
    return nodeText(cell.v).trim() === "1" ? "true" : "false";
  }
  if (type === "e") {
    return nodeText(cell.v);
  }

  // Number, or a formula cell whose cached value is numeric (no `t`).
  const raw = nodeText(cell.v);
  if (raw === "") {
    return "";
  }
  const styleIndex = Number(cell["@_s"]);
  if (Number.isFinite(styleIndex) && dateFlags[styleIndex] === true) {
    const serial = Number(raw);
    if (Number.isFinite(serial)) {
      return serialToIso(serial);
    }
  }
  const num = Number(raw);
  return Number.isNaN(num) ? raw : String(num);
}

function parseSheetRows(
  raw: Buffer,
  sharedStrings: readonly string[],
  dateFlags: readonly boolean[],
): string[][] {
  const doc = parser.parse(raw.toString("utf-8")) as unknown;
  const worksheet = isRecord(doc) ? doc.worksheet : undefined;
  const sheetData = isRecord(worksheet) ? worksheet.sheetData : undefined;
  if (!isRecord(sheetData)) {
    return [];
  }

  const rows: string[][] = [];
  for (const row of asArray(sheetData.row)) {
    if (!isRecord(row)) {
      continue;
    }
    const cells = asArray(row.c).filter(isRecord);
    if (cells.length === 0) {
      continue;
    }

    const built: string[] = [];
    let nextDefaultColumn = 0;
    for (const cell of cells) {
      const ref = cell["@_r"];
      const column =
        typeof ref === "string" && ref.length > 0 ? columnIndex(ref) : nextDefaultColumn;
      const target = column >= 0 ? column : nextDefaultColumn;
      while (built.length < target) {
        built.push("");
      }
      built[target] = cellToString(cell, sharedStrings, dateFlags);
      nextDefaultColumn = target + 1;
    }

    if (built.every((value) => value === "")) {
      continue;
    }
    rows.push(built);
  }
  return rows;
}

function looksEncrypted(buffer: Buffer): boolean {
  if (
    buffer.length < OLE_SIGNATURE.length ||
    !buffer.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)
  ) {
    return false;
  }
  // Directory-entry names in a CFB are stored as UTF-16LE. An encrypted
  // OOXML package always contains "EncryptedPackage" and "EncryptionInfo"
  // streams.
  const encryptedPackage = Buffer.from("EncryptedPackage", "utf16le");
  const encryptionInfo = Buffer.from("EncryptionInfo", "utf16le");
  return buffer.includes(encryptedPackage) || buffer.includes(encryptionInfo);
}

function isOleContainer(buffer: Buffer): boolean {
  return (
    buffer.length >= OLE_SIGNATURE.length &&
    buffer.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)
  );
}

/**
 * Parse a raw `.xlsx` buffer into one entry per worksheet in document
 * order, with every cell stringified. Throws `XlsxEncryptedError` for
 * encrypted workbooks and `XlsxParseError` for anything else that cannot
 * be parsed.
 */
export async function readXlsxSheets(buffer: Buffer): Promise<XlsxSheet[]> {
  if (isOleContainer(buffer)) {
    if (looksEncrypted(buffer)) {
      throw new XlsxEncryptedError("Workbook is an encrypted (password-protected) package");
    }
    throw new XlsxParseError("Buffer is an OLE compound document, not an .xlsx ZIP container");
  }

  let entries: Map<string, Buffer>;
  try {
    entries = await readZipEntries(buffer);
  } catch (error: unknown) {
    throw new XlsxParseError("Failed to read XLSX archive", { cause: error });
  }

  let sharedStrings: readonly string[];
  let dateFlags: readonly boolean[];
  let sheetRefs: SheetRef[];
  try {
    sharedStrings = parseSharedStrings(entries);
    dateFlags = parseStyles(entries).dateFlags;
    sheetRefs = parseWorkbook(entries);
  } catch (error: unknown) {
    if (error instanceof XlsxParseError) {
      throw error;
    }
    throw new XlsxParseError("Failed to parse XLSX workbook structure", {
      cause: error,
    });
  }

  return sheetRefs.map((ref) => {
    const raw = entries.get(ref.path);
    const rows = raw === undefined ? [] : parseSheetRows(raw, sharedStrings, dateFlags);
    return { name: ref.name, rows };
  });
}
