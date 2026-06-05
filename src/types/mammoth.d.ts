/**
 * Minimal ambient type declarations for the `mammoth` package, which
 * ships no types of its own. Only the surface used by the DOCX
 * extractor is declared — extend as needed.
 */
declare module "mammoth" {
  export interface MammothInput {
    readonly buffer: Buffer;
  }

  export interface MammothMessage {
    readonly type: "warning" | "error";
    readonly message: string;
  }

  export interface MammothResult {
    readonly value: string;
    readonly messages: readonly MammothMessage[];
  }

  export function convertToMarkdown(input: MammothInput): Promise<MammothResult>;
  export function convertToHtml(input: MammothInput): Promise<MammothResult>;
  export function extractRawText(input: MammothInput): Promise<MammothResult>;
}
