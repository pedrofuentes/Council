/**
 * Render a {@link ConfigModel} into the committed documentation artifacts: the
 * Starlight `config-reference.mdx` page and a machine-readable `config.json`.
 *
 * Pure and deterministic: given the same model it always produces byte-for-byte
 * identical output, which is what lets `docs:check:config` detect drift. All
 * descriptive text is markdown-escaped so literal placeholders like `--engine`
 * or `<name>` render verbatim instead of being interpreted as markdown or MDX.
 */
import type { ConfigKeyModel, ConfigModel, EnvVarModel } from "./config-model";
import type { GeneratedFile } from "./render";

export type { GeneratedFile } from "./render";

export const CONFIG_GENERATED_FILE_WARNING =
  "DO NOT EDIT — this file is auto-generated from the Council CLI's Zod config " +
  "schema by `pnpm --filter @council-ai/site docs:generate:config`. Run that " +
  "command to regenerate it, and `pnpm --filter @council-ai/site " +
  "docs:check:config` to verify it is in sync.";

const CONFIG_DOC_PATH = "src/content/docs/reference/config-reference.mdx";
const CONFIG_JSON_PATH = "src/generated/config.json";

/**
 * Markdown/MDX-escape literal inline text: collapse whitespace and
 * backslash-escape the characters that would otherwise be parsed as markdown,
 * HTML, or MDX expressions.
 */
function escapeInline(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]<>{}|~])/g, "\\$1");
}

function inlineCode(text: string): string {
  return `\`${text}\``;
}

function formatDefault(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return inlineCode(text);
}

/** Render the type cell, folding enum choices and numeric ranges into it. */
function renderTypeCell(key: ConfigKeyModel): string {
  if (key.type === "enum" && key.enumValues !== undefined && key.enumValues.length > 0) {
    return key.enumValues.map(inlineCode).join(" \\| ");
  }
  const base = inlineCode(key.type);
  if (key.min !== undefined && key.max !== undefined) {
    return `${base} (${key.min}–${key.max})`;
  }
  return base;
}

function renderKeysTable(keys: readonly ConfigKeyModel[]): string {
  const rows = keys.map((key) => {
    const defaultCell = key.hasDefault ? formatDefault(key.default) : "—";
    return `| ${inlineCode(key.path)} | ${renderTypeCell(key)} | ${defaultCell} | ${escapeInline(key.description)} |`;
  });
  return ["| Key | Type | Default | Description |", "| --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}

function renderSection(section: ConfigModel["sections"][number]): string {
  const blocks: string[] = [`### ${inlineCode(section.name)}`];
  if (section.description.length > 0) {
    blocks.push(escapeInline(section.description));
  }
  blocks.push(renderKeysTable(section.keys));
  return blocks.join("\n\n");
}

function renderEnvVarsTable(envVars: readonly EnvVarModel[]): string {
  const rows = envVars.map((envVar) => {
    const defaultCell = envVar.default === "" ? "—" : inlineCode(envVar.default);
    return `| ${inlineCode(envVar.name)} | ${escapeInline(envVar.purpose)} | ${defaultCell} |`;
  });
  return ["| Variable | Purpose | Default |", "| --- | --- | --- |", ...rows].join("\n");
}

function renderFrontmatter(title: string, description: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n`;
}

function renderPage(model: ConfigModel): GeneratedFile {
  const blocks: string[] = [
    `> ${CONFIG_GENERATED_FILE_WARNING}`,
    "Every Council configuration key and environment variable, generated from the CLI's own Zod config schema so this reference can never drift from the code.",
    "## Configuration keys",
    "Settings live in `~/.council/config.yaml`. All keys are optional and fall back to the defaults below. Use the dot-path with `council config set <key> <value>`.",
    ...model.sections.map(renderSection),
    "## Environment variables",
    "Environment variables override configuration at runtime and tune rendering and integration behavior.",
    renderEnvVarsTable(model.envVars),
    "## Related",
    [
      "- [Configuration](/Council/reference/configuration/) — narrative guide to editing `config.yaml`.",
      "- [Environment Variables](/Council/reference/environment-variables/) — detailed environment-variable guide.",
      "- [Data Locations](/Council/reference/data-locations/) — directory structure and file locations.",
    ].join("\n"),
  ];
  const frontmatter = renderFrontmatter(
    "Config & Environment Reference",
    "Auto-generated reference for every Council config.yaml setting and environment variable.",
  );
  return {
    path: CONFIG_DOC_PATH,
    contents: `${frontmatter}\n${blocks.join("\n\n")}\n`,
  };
}

function renderJson(model: ConfigModel): GeneratedFile {
  const payload = {
    $generated: CONFIG_GENERATED_FILE_WARNING,
    $source: "@council-ai/cli ConfigSchema (Zod)",
    config: {
      sections: model.sections,
      envVars: model.envVars,
    },
  };
  return { path: CONFIG_JSON_PATH, contents: `${JSON.stringify(payload, null, 2)}\n` };
}

/**
 * Produce every generated file for the config & environment reference: the
 * Starlight page and the serialised JSON model.
 */
export function renderConfigReference(model: ConfigModel): readonly GeneratedFile[] {
  return [renderPage(model), renderJson(model)];
}
