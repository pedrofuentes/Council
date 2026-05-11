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
import { describe, expect, it } from "vitest";

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

describe("selectRenderer", () => {
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

  it("format=auto on TTY returns InkRenderer", () => {
    expect(selectRenderer({ format: "auto", isTTY: true, sink })).toBeInstanceOf(InkRenderer);
  });

  it("format=auto off TTY returns PlainRenderer (graceful degrade)", () => {
    expect(selectRenderer({ format: "auto", isTTY: false, sink })).toBeInstanceOf(PlainRenderer);
  });
});
