import { describe, expect, it, vi } from "vitest";

import {
  SETTINGS_FIELDS,
  buildSettingsFields,
  createSettingsDataSource,
  readFieldValue,
  validateField,
  type SettingsFieldDescriptor,
} from "../../../src/tui/adapters/config-settings.js";

const field = (path: string): SettingsFieldDescriptor => {
  const descriptor = SETTINGS_FIELDS.find((candidate) => candidate.path === path);
  if (descriptor === undefined) {
    throw new Error(`Missing descriptor: ${path}`);
  }
  return descriptor;
};

describe("readFieldValue", () => {
  it("reads a nested number and renders it as a string", () => {
    expect(readFieldValue({ defaults: { maxRounds: 7 } }, "defaults.maxRounds")).toBe("7");
  });

  it("renders boolean values as true and false strings", () => {
    expect(readFieldValue({ telemetry: { enabled: true } }, "telemetry.enabled")).toBe("true");
    expect(readFieldValue({ telemetry: { enabled: false } }, "telemetry.enabled")).toBe("false");
  });

  it("passes string values through unchanged", () => {
    expect(readFieldValue({ defaults: { model: "gpt-5" } }, "defaults.model")).toBe("gpt-5");
  });

  it("returns an empty string for a missing path", () => {
    expect(readFieldValue({ defaults: {} }, "defaults.maxRounds")).toBe("");
  });

  it("returns an empty string when a mid-path value is not an object", () => {
    expect(readFieldValue({ defaults: "not-object" }, "defaults.maxRounds")).toBe("");
  });

  it("returns an empty string for null, undefined, and object leaf values", () => {
    expect(readFieldValue({ defaults: { model: null } }, "defaults.model")).toBe("");
    expect(readFieldValue({ defaults: { model: undefined } }, "defaults.model")).toBe("");
    expect(readFieldValue({ defaults: { model: { nested: "value" } } }, "defaults.model")).toBe("");
  });
});

describe("validateField", () => {
  describe("string fields", () => {
    it("rejects empty required strings", () => {
      expect(validateField(field("defaults.model"), "   ")).toEqual({
        ok: false,
        error: "Required",
      });
    });

    it("accepts empty optional strings", () => {
      expect(validateField(field("providers.openai.apiKeyEnvVar"), "   ")).toEqual({
        ok: true,
        value: "",
      });
    });

    it("rejects control characters", () => {
      expect(validateField(field("defaults.model"), "model\nname")).toEqual({
        ok: false,
        error: "No control characters",
      });
    });

    it("trims and accepts normal strings", () => {
      expect(validateField(field("defaults.model"), "  gpt-5  ")).toEqual({
        ok: true,
        value: "gpt-5",
      });
    });
  });

  describe("integer number fields", () => {
    const integerField = (): SettingsFieldDescriptor => field("qualityGate.maxRegenerations");

    it("rejects empty integer input", () => {
      expect(validateField(integerField(), "")).toEqual({
        ok: false,
        error: "Must be a whole number",
      });
    });

    it("rejects hex integer input", () => {
      expect(validateField(integerField(), "0x2")).toEqual({
        ok: false,
        error: "Must be a whole number",
      });
    });

    it("rejects exponent integer input", () => {
      expect(validateField(integerField(), "1e3")).toEqual({
        ok: false,
        error: "Must be a whole number",
      });
    });

    it("rejects fractional integer input", () => {
      expect(validateField(integerField(), "1.0")).toEqual({
        ok: false,
        error: "Must be a whole number",
      });
    });

    it("rejects out-of-range integers", () => {
      expect(validateField(integerField(), "5")).toEqual({
        ok: false,
        error: "Must be between 0 and 3",
      });
    });

    it("accepts in-range integers", () => {
      expect(validateField(integerField(), "2")).toEqual({ ok: true, value: 2 });
    });
  });

  describe("non-integer number fields", () => {
    it("rejects empty number input", () => {
      expect(validateField(field("documents.maxFileSizeMB"), "")).toEqual({
        ok: false,
        error: "Must be a number",
      });
    });

    it("rejects non-finite number input", () => {
      expect(validateField(field("documents.maxFileSizeMB"), "abc")).toEqual({
        ok: false,
        error: "Must be a number",
      });
      expect(validateField(field("documents.maxFileSizeMB"), "Infinity")).toEqual({
        ok: false,
        error: "Must be a number",
      });
    });

    it("rejects out-of-range non-integer numbers", () => {
      expect(validateField(field("documents.maxFileSizeMB"), "0.5")).toEqual({
        ok: false,
        error: "Must be between 1 and 500",
      });
    });

    it("accepts valid fractional values for max file size", () => {
      expect(validateField(field("documents.maxFileSizeMB"), "12.5")).toEqual({
        ok: true,
        value: 12.5,
      });
    });

    it("accepts valid values for max transcript chars", () => {
      expect(validateField(field("conclude.maxTranscriptChars"), "50000")).toEqual({
        ok: true,
        value: 50000,
      });
    });
  });

  describe("boolean fields", () => {
    it("accepts yes as true", () => {
      expect(validateField(field("telemetry.enabled"), "yes")).toEqual({ ok: true, value: true });
    });

    it("accepts off as false", () => {
      expect(validateField(field("telemetry.enabled"), "off")).toEqual({ ok: true, value: false });
    });

    it("rejects invalid booleans", () => {
      expect(validateField(field("telemetry.enabled"), "maybe")).toEqual({
        ok: false,
        error: "Must be true or false",
      });
    });
  });

  describe("enum fields", () => {
    it("accepts a listed enum option", () => {
      expect(validateField(field("defaults.engine"), "copilot")).toEqual({
        ok: true,
        value: "copilot",
      });
    });

    it("rejects values outside the enum options", () => {
      expect(validateField(field("defaults.engine"), "local")).toEqual({
        ok: false,
        error: "Must be one of: copilot, mock, openai, anthropic",
      });
    });
  });
});

describe("buildSettingsFields", () => {
  it("builds all setting states with current string values", () => {
    const fields = buildSettingsFields({
      defaults: { model: "gpt-5", maxRounds: 7 },
      telemetry: { enabled: true },
    });

    expect(fields).toHaveLength(18);
    expect(fields.find((candidate) => candidate.path === "defaults.model")?.value).toBe("gpt-5");
    expect(fields.find((candidate) => candidate.path === "defaults.maxRounds")?.value).toBe("7");
    expect(fields.find((candidate) => candidate.path === "telemetry.enabled")?.value).toBe("true");
    expect(fields.find((candidate) => candidate.path === "paths.dataHome")?.value).toBe("");
  });
});

describe("createSettingsDataSource", () => {
  it("loads settings from the injected config loader", async () => {
    const dataSource = createSettingsDataSource({
      loadConfig: async () => ({ defaults: { model: "gpt-5" } }),
      updateConfigFields: async () => undefined,
    });

    const fields = await dataSource.load();

    expect(fields).toHaveLength(18);
    expect(fields.find((candidate) => candidate.path === "defaults.model")?.value).toBe("gpt-5");
  });

  it("saves path changes as config key updates", async () => {
    const updateConfigFields = vi.fn<
      (
        updates: readonly { readonly key: string; readonly value: string | number | boolean }[],
      ) => Promise<void>
    >(async () => undefined);
    const dataSource = createSettingsDataSource({
      loadConfig: async () => ({}),
      updateConfigFields,
    });

    await dataSource.save([
      { path: "defaults.model", value: "gpt-5" },
      { path: "telemetry.enabled", value: false },
    ]);

    expect(updateConfigFields).toHaveBeenCalledWith([
      { key: "defaults.model", value: "gpt-5" },
      { key: "telemetry.enabled", value: false },
    ]);
    expect(updateConfigFields).toHaveBeenCalledTimes(1);
  });
});
