/**
 * Tests for #241: preamble support is a declarative property of each
 * `Renderer`, not an `instanceof PlainRenderer` check in `run-with-engine.ts`.
 *
 * Preambles are plain-text headers. The plain renderer emits them; the JSON
 * renderer must stay machine-parseable and Ink owns its own framing, so both
 * declare `supportsPreamble = false`. Consumers read `renderer.supportsPreamble`
 * to decide whether to emit the preamble.
 */
import { describe, expect, it } from "vitest";

import { JsonRenderer } from "../../../../src/cli/renderers/json.js";
import { PlainRenderer } from "../../../../src/cli/renderers/plain.js";
import { InkRenderer } from "../../../../src/cli/renderers/ink/InkRenderer.js";
import { selectRenderer } from "../../../../src/cli/renderers/select.js";
import type { Sink } from "../../../../src/cli/renderers/types.js";

const sink: Sink = {
  write: () => {
    /* discard */
  },
};

describe("Renderer.supportsPreamble (#241)", () => {
  it("PlainRenderer supports preambles", () => {
    expect(new PlainRenderer(sink).supportsPreamble).toBe(true);
  });

  it("JsonRenderer does not support preambles (machine-parseable stream)", () => {
    expect(new JsonRenderer(sink).supportsPreamble).toBe(false);
  });

  it("InkRenderer does not support preambles (owns its own framing)", () => {
    expect(new InkRenderer().supportsPreamble).toBe(false);
  });

  it("selectRenderer(plain) yields a preamble-supporting renderer", () => {
    expect(selectRenderer({ format: "plain", isTTY: false, sink }).supportsPreamble).toBe(true);
  });

  it("selectRenderer(json) yields a non-preamble renderer", () => {
    expect(selectRenderer({ format: "json", isTTY: true, sink }).supportsPreamble).toBe(false);
  });
});
