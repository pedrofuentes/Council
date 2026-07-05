import { describe, expect, it } from "vitest";

import type {
  CommandArgumentModel,
  CommandModel,
  CommandOptionModel,
} from "../../src/lib/reference/command-model";
import { renderReference } from "../../src/lib/reference/render";

// Adversarial coverage for the renderer's inline escaping. The real-CLI drift
// tests in generate-command-reference.test.ts only exercise `escapeInline` with
// benign Commander help text, so a regression that stopped escaping a character
// (or broke whitespace collapsing) would ship markdown/MDX-injection and
// table-break bugs undetected. These tests feed a synthetic CommandModel with
// out-of-class characters straight through the public `renderReference` surface
// and assert on the rendered markdown body (frontmatter data fields are
// JSON-quoted and escaped by Astro, so they are not the injection surface).

// Characters `escapeInline` must backslash-escape so CLI help renders verbatim
// instead of being parsed as markdown emphasis/code/links/HTML, and so a `|`
// inside a table cell cannot break the surrounding table.
const OUT_OF_CLASS = ["\\", "`", "*", "_", "[", "]", "<", ">", "|", "~"] as const;
const BACKSLASH = "\\";
// A character that is never escaped, used to bracket each special character so
// the `toContain` assertions match an unambiguous, isolated occurrence.
const SAFE = "x";
const DEMO_PAGE_PATH = "src/content/docs/reference/commands/demo.md";
// A well-formed 3-column table row has exactly four structural `|` delimiters.
const TABLE_ROW_DELIMITERS = 4;

function optionModel(overrides: Partial<CommandOptionModel> = {}): CommandOptionModel {
  return {
    flags: "--opt <value>",
    description: "",
    required: false,
    optional: false,
    variadic: false,
    negate: false,
    ...overrides,
  };
}

function argumentModel(overrides: Partial<CommandArgumentModel> = {}): CommandArgumentModel {
  return {
    name: "arg",
    display: "[arg]",
    description: "",
    required: false,
    variadic: false,
    ...overrides,
  };
}

function commandModel(overrides: Partial<CommandModel> = {}): CommandModel {
  return {
    name: "demo",
    path: ["council", "demo"],
    commandPath: "council demo",
    description: "",
    aliases: [],
    usage: "",
    arguments: [],
    options: [],
    subcommands: [],
    ...overrides,
  };
}

/** Strip the leading `--- ... ---` YAML frontmatter, returning the markdown body. */
function stripFrontmatter(page: string): string {
  const match = /^---\n.*?\n---\n/s.exec(page);
  return match === null ? page : page.slice(match[0].length);
}

/** Render a synthetic tree and return the `demo` top-level command page body. */
function renderDemoBody(demoOverrides: Partial<CommandModel>): string {
  const root = commandModel({
    name: "council",
    path: ["council"],
    commandPath: "council",
    subcommands: [commandModel(demoOverrides)],
  });
  const files = renderReference(root);
  const byPath = new Map(files.map((file) => [file.path, file.contents] as const));
  return stripFrontmatter(byPath.get(DEMO_PAGE_PATH) ?? "");
}

/** Count `|` characters that are NOT backslash-escaped (i.e. table delimiters). */
function countStructuralPipes(row: string): number {
  return (row.match(/(?<!\\)\|/g) ?? []).length;
}

describe("renderReference escaping", () => {
  it("backslash-escapes every out-of-class character in a command description", () => {
    const description = OUT_OF_CLASS.map((character) => SAFE + character + SAFE).join(" ");

    const body = renderDemoBody({ description });

    for (const character of OUT_OF_CLASS) {
      expect(body).toContain(SAFE + BACKSLASH + character + SAFE);
    }
  });

  it("collapses runs of whitespace so multi-line help cannot break a row", () => {
    const body = renderDemoBody({ description: "first\nsecond\tthird    fourth" });

    expect(body).toContain("first second third fourth");
    expect(body).not.toContain("first\nsecond");
    expect(body).not.toContain("third    fourth");
  });

  it("escapes angle brackets so raw HTML/MDX tags cannot be injected", () => {
    const body = renderDemoBody({ description: "run <script>alert('xss')</script> now" });

    expect(body).not.toContain("<script>");
    expect(body).not.toContain("</script>");
    expect(body).toContain("\\<script\\>");
    expect(body).toContain("\\</script\\>");
  });

  it("escapes pipes in an option description so table columns are not broken", () => {
    const body = renderDemoBody({
      options: [optionModel({ flags: "--opt <value>", description: "col1 | col2 | col3" })],
    });

    const row = body.split("\n").find((line) => line.includes("--opt")) ?? "";
    expect(row).toContain("col1 \\| col2 \\| col3");
    expect(countStructuralPipes(row)).toBe(TABLE_ROW_DELIMITERS);
  });

  it("escapes pipes in an argument description so table columns are not broken", () => {
    const body = renderDemoBody({
      arguments: [argumentModel({ display: "[arg]", description: "col1 | col2 | col3" })],
    });

    const row = body.split("\n").find((line) => line.includes("[arg]")) ?? "";
    expect(row).toContain("col1 \\| col2 \\| col3");
    expect(countStructuralPipes(row)).toBe(TABLE_ROW_DELIMITERS);
  });
});
