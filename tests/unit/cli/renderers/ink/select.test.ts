/**
 * Tests for the renderer selection factory.
 *
 * The Council CLI supports three output formats:
 *   - "json"  → always NDJSON, regardless of TTY
 *   - "plain" → always plain text, regardless of TTY
 *   - "auto"  → Ink TUI on TTY, plain text otherwise
 *
 * Explicit --format flags must always override TTY auto-detection so
 * piped output and CI runs stay deterministic.
 *
 * RED at this commit: src/cli/renderers/select.ts does not exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectRenderer } from "../../../../../src/cli/renderers/select.js";
import { JsonRenderer } from "../../../../../src/cli/renderers/json.js";
import { PlainRenderer } from "../../../../../src/cli/renderers/plain.js";
import { InkRenderer } from "../../../../../src/cli/renderers/ink/InkRenderer.js";
import type { Sink } from "../../../../../src/cli/renderers/types.js";

const sink: Sink = {
  write: () => {
    /* discard */
  },
};

let originalTerm: string | undefined;
let originalCi: string | undefined;
let originalAccessibility: string | undefined;

describe("selectRenderer", () => {
  beforeEach(() => {
    originalTerm = process.env["TERM"];
    originalCi = process.env["CI"];
    originalAccessibility = process.env["ACCESSIBILITY"];
  });

  afterEach(() => {
    if (originalTerm === undefined) delete process.env["TERM"];
    else process.env["TERM"] = originalTerm;

    if (originalCi === undefined) delete process.env["CI"];
    else process.env["CI"] = originalCi;

    if (originalAccessibility === undefined) delete process.env["ACCESSIBILITY"];
    else process.env["ACCESSIBILITY"] = originalAccessibility;
  });
  it("format=json returns JsonRenderer on TTY", () => {
    expect(selectRenderer({ format: "json", isTTY: true, sink })).toBeInstanceOf(JsonRenderer);
  });

  it("format=json returns JsonRenderer off TTY", () => {
    expect(selectRenderer({ format: "json", isTTY: false, sink })).toBeInstanceOf(JsonRenderer);
  });

  it("format=plain returns PlainRenderer on TTY (override)", () => {
    expect(selectRenderer({ format: "plain", isTTY: true, sink })).toBeInstanceOf(PlainRenderer);
  });

  it("format=plain returns PlainRenderer off TTY", () => {
    expect(selectRenderer({ format: "plain", isTTY: false, sink })).toBeInstanceOf(PlainRenderer);
  });

  it("format=auto on TTY returns InkRenderer when no plain-forcing env vars are set", () => {
    delete process.env["TERM"];
    delete process.env["CI"];
    delete process.env["ACCESSIBILITY"];

    expect(selectRenderer({ format: "auto", isTTY: true, sink })).toBeInstanceOf(InkRenderer);
  });

  it("format=auto off TTY returns PlainRenderer (graceful degrade)", () => {
    expect(selectRenderer({ format: "auto", isTTY: false, sink })).toBeInstanceOf(PlainRenderer);
  });
});
