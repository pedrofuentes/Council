import { stripControlChars, toSingleLineDisplay } from "../strip-control-chars.js";

export function sanitizeExportBlock(text: string): string {
  return stripControlChars(text.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n"));
}

export function sanitizeExportLine(text: string): string {
  return toSingleLineDisplay(text);
}

export function sanitizeExportBlockLines(text: string): readonly string[] {
  return sanitizeExportBlock(text).split("\n");
}
