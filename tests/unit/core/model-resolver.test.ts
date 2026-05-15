import { describe, expect, it } from "vitest";

import { resolveModel } from "../../../src/core/model-resolver.js";

describe("resolveModel", () => {
  it("returns expertModel when all three layers are set", () => {
    expect(
      resolveModel({
        expertModel: "expert-model",
        panelDefaultModel: "panel-model",
        configDefaultModel: "global-model",
      }),
    ).toBe("expert-model");
  });

  it("falls back to panelDefaultModel when expertModel is undefined", () => {
    expect(
      resolveModel({
        panelDefaultModel: "panel-model",
        configDefaultModel: "global-model",
      }),
    ).toBe("panel-model");
  });

  it("falls back to configDefaultModel when both expert and panel are undefined", () => {
    expect(
      resolveModel({
        configDefaultModel: "global-model",
      }),
    ).toBe("global-model");
  });

  it("skips empty-string expertModel (treated as unset)", () => {
    expect(
      resolveModel({
        expertModel: "",
        panelDefaultModel: "panel-model",
        configDefaultModel: "global-model",
      }),
    ).toBe("panel-model");
  });

  it("skips empty-string panelDefaultModel", () => {
    expect(
      resolveModel({
        expertModel: undefined,
        panelDefaultModel: "",
        configDefaultModel: "global-model",
      }),
    ).toBe("global-model");
  });
});
