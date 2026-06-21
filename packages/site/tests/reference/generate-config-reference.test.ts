import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { buildConfigModel } from "../../src/lib/reference/config-model";
import {
  CONFIG_DESCRIPTIONS,
  ENV_VARS,
  IGNORED_ENV_VARS,
} from "../../src/lib/reference/config-metadata";
import {
  CONFIG_GENERATED_FILE_WARNING,
  renderConfigReference,
} from "../../src/lib/reference/config-render";
import {
  buildReferenceModel,
  collectConfigReferenceFiles,
  SITE_ROOT,
} from "../../scripts/generate-config-reference.ts";
import { findDriftedFiles } from "../../scripts/check-config-reference.ts";

const CONFIG_MDX_PATH = "src/content/docs/reference/config-reference.mdx";
const CONFIG_JSON_PATH = "src/generated/config.json";

// These tests pin the config-reference generator to the REAL Zod `ConfigSchema`
// exported by @council-ai/cli. They are the drift guard's first line of defence:
// if a config key's path, type, default, or constraints change in the schema,
// the introspected model — and therefore these assertions — change with it.
describe("buildConfigModel", () => {
  const model = buildReferenceModel();
  const byPath = new Map(model.keys.map((key) => [key.path, key] as const));

  it("captures defaults.model with its real default and string type", () => {
    const modelKey = byPath.get("defaults.model");
    expect(modelKey).toBeDefined();
    expect(modelKey?.type).toBe("string");
    expect(modelKey?.default).toBe("claude-sonnet-4.5");
  });

  it("captures telemetry.enabled as a boolean defaulting to false", () => {
    const enabled = byPath.get("telemetry.enabled");
    expect(enabled?.type).toBe("boolean");
    expect(enabled?.hasDefault).toBe(true);
    expect(enabled?.default).toBe(false);
  });

  it("captures defaults.engine as an enum including copilot and mock", () => {
    const engine = byPath.get("defaults.engine");
    expect(engine?.type).toBe("enum");
    expect(engine?.enumValues).toEqual(expect.arrayContaining(["copilot", "mock"]));
    expect(engine?.default).toBe("copilot");
  });

  it("captures numeric ranges for defaults.maxRounds", () => {
    const maxRounds = byPath.get("defaults.maxRounds");
    expect(maxRounds?.type).toBe("integer");
    expect(maxRounds?.min).toBe(1);
    expect(maxRounds?.max).toBe(20);
    expect(maxRounds?.default).toBe(4);
  });

  it("captures array types and nested provider keys", () => {
    expect(byPath.get("expert.supportedFormats")?.type).toBe("string[]");

    const apiKeyEnvVar = byPath.get("providers.openai.apiKeyEnvVar");
    expect(apiKeyEnvVar?.type).toBe("string");
    expect(apiKeyEnvVar?.hasDefault).toBe(false);
  });

  it("groups every leaf key under its top-level section", () => {
    const defaults = model.sections.find((section) => section.name === "defaults");
    expect(defaults).toBeDefined();
    expect(defaults?.keys.map((key) => key.path)).toContain("defaults.maxExperts");
  });

  it("attaches the curated description to each key", () => {
    expect(byPath.get("telemetry.enabled")?.description).toBe(
      CONFIG_DESCRIPTIONS["telemetry.enabled"],
    );
  });

  it("throws when a config key has no curated description", () => {
    expect(() =>
      buildConfigModel(
        { properties: { foo: { properties: { bar: { type: "string" } } } } },
        {},
        [],
      ),
    ).toThrow(/foo\.bar/);
  });
});

describe("renderConfigReference", () => {
  const files = renderConfigReference(buildReferenceModel());
  const byPath = new Map(files.map((file) => [file.path, file.contents] as const));
  const mdx = byPath.get(CONFIG_MDX_PATH);
  const json = byPath.get(CONFIG_JSON_PATH);

  it("emits the config reference page and the JSON model", () => {
    expect(byPath.has(CONFIG_MDX_PATH)).toBe(true);
    expect(byPath.has(CONFIG_JSON_PATH)).toBe(true);
  });

  it("marks every generated file as do-not-edit", () => {
    for (const [, contents] of byPath) {
      expect(contents).toContain(CONFIG_GENERATED_FILE_WARNING);
    }
  });

  it("documents config keys with their defaults on the page", () => {
    expect(mdx).toContain("defaults.model");
    expect(mdx).toContain("claude-sonnet-4.5");
    expect(mdx).toContain("telemetry.enabled");
  });

  it("documents environment variables on the page", () => {
    expect(mdx).toContain("COUNCIL_HOME");
    expect(mdx).toContain("NO_COLOR");
  });

  it("links Related entries at /Council/reference without a /docs/ segment", () => {
    // Starlight serves these reference pages at /Council/reference/<page>/, not
    // /Council/docs/reference/<page>/. The generator must emit the live URLs so
    // regenerating never reintroduces the broken /docs/ links fixed in #1398.
    expect(mdx).toContain("(/Council/reference/configuration/)");
    expect(mdx).toContain("(/Council/reference/environment-variables/)");
    expect(mdx).toContain("(/Council/reference/data-locations/)");
    expect(mdx).not.toContain("/Council/docs/reference/");
    expect(mdx).not.toContain("/docs/reference/");
  });

  it("serialises sections and environment variables to config.json", () => {
    const parsed = JSON.parse(json ?? "{}") as {
      config: {
        sections: readonly { name: string }[];
        envVars: readonly { name: string }[];
      };
    };
    expect(parsed.config.sections.map((section) => section.name)).toContain("defaults");
    expect(parsed.config.envVars.map((envVar) => envVar.name)).toContain("COUNCIL_HOME");
  });
});

describe("config reference drift check", () => {
  const expected = collectConfigReferenceFiles();

  it("reports no drift for the committed output", () => {
    const problems = findDriftedFiles(expected, (relativePath) => {
      const absolute = path.join(SITE_ROOT, relativePath);
      return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined;
    });
    expect(problems).toEqual([]);
  });

  it("reports drift when a generated file is stale", () => {
    const target = expected[0]?.path ?? "";
    const problems = findDriftedFiles(expected, (relativePath) => {
      const file = expected.find((candidate) => candidate.path === relativePath);
      return relativePath === target ? `${file?.contents ?? ""}# injected drift` : file?.contents;
    });
    expect(problems).toContain(`outdated ${target}`);
  });

  it("reports drift when a generated file is missing", () => {
    const problems = findDriftedFiles(expected, () => undefined);
    expect(problems.length).toBe(expected.length);
  });

  it("exits zero when run as a script against the committed output", () => {
    const script = path.join(SITE_ROOT, "scripts/check-config-reference.ts");
    expect(() => execFileSync(process.execPath, [script], { stdio: "pipe" })).not.toThrow();
  });
});

describe("environment variable coverage", () => {
  it("documents every environment variable read in the CLI source", () => {
    const sourceDir = path.resolve(SITE_ROOT, "../cli/src");
    const documented = new Set<string>([
      ...ENV_VARS.map((envVar) => envVar.name),
      ...IGNORED_ENV_VARS,
    ]);
    const undocumented = [...collectEnvVarNames(sourceDir)].filter((name) => !documented.has(name));
    expect(undocumented).toEqual([]);
  });
});

/** Collect every literal `process.env` access name from the CLI source tree. */
function collectEnvVarNames(dir: string): Set<string> {
  const names = new Set<string>();
  const pattern = /process\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])/g;
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    const text = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
    for (const match of text.matchAll(pattern)) {
      const name = match[1] ?? match[2];
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return names;
}
