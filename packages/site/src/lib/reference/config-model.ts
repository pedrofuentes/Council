/**
 * A serialisable, Zod-agnostic model of the Council configuration schema.
 *
 * The Council CLI defines its configuration as a Zod `ConfigSchema`
 * (`@council-ai/cli`). The build-time generator converts that schema into a
 * JSON Schema (Zod's own `toJSONSchema()` introspection) and feeds the plain,
 * JSON-friendly result into {@link buildConfigModel}. Keeping the model here —
 * with only structural JSON Schema source types and no `zod` import — means the
 * site never bundles the CLI or Zod: the model is data, and the schema is only
 * touched by the build-time scripts that feed real introspection output in.
 *
 * Human-friendly descriptions are editorial and live alongside the model in
 * `config-metadata.ts`; the schema is the source of truth for every key, type,
 * default, and constraint. Adding a key to the schema without a description is a
 * hard error, so the docs can never silently fall out of sync with the schema.
 */

/** Structural view of the subset of a JSON Schema node we read. */
export interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** A single environment variable recognised by Council. */
export interface EnvVarModel {
  /** Variable name, e.g. `COUNCIL_HOME`. */
  readonly name: string;
  /** One-line description of what the variable controls. */
  readonly purpose: string;
  /** Human-readable default, e.g. `~/.council/` or `(unset)`. */
  readonly default: string;
}

/** A single leaf configuration key (one `config.yaml` setting). */
export interface ConfigKeyModel {
  /** Dot-notation path used by `council config set`, e.g. `defaults.model`. */
  readonly path: string;
  /** Path split into segments, e.g. `["defaults", "model"]`. */
  readonly segments: readonly string[];
  /** Top-level section the key belongs to, e.g. `defaults`. */
  readonly section: string;
  /** Display type label, e.g. `string`, `integer`, `boolean`, `enum`, `string[]`. */
  readonly type: string;
  /** Allowed values when {@link type} is `enum`. */
  readonly enumValues?: readonly string[];
  /** Whether the schema provides a default for this key. */
  readonly hasDefault: boolean;
  /** Default value, present only when {@link hasDefault} is `true`. */
  readonly default?: unknown;
  /** Inclusive lower bound for numeric keys. */
  readonly min?: number;
  /** Inclusive upper bound for numeric keys. */
  readonly max?: number;
  /** Curated, human-friendly description. */
  readonly description: string;
}

/** A top-level configuration section grouping related keys. */
export interface ConfigSectionModel {
  /** Section name, e.g. `defaults`. */
  readonly name: string;
  /** Curated section summary (may be empty). */
  readonly description: string;
  /** Leaf keys under this section, in schema order. */
  readonly keys: readonly ConfigKeyModel[];
}

/** The complete config & environment reference model. */
export interface ConfigModel {
  readonly sections: readonly ConfigSectionModel[];
  /** Flattened view of every leaf key across all sections. */
  readonly keys: readonly ConfigKeyModel[];
  readonly envVars: readonly EnvVarModel[];
}

function deriveType(node: JsonSchemaNode): { type: string; enumValues?: readonly string[] } {
  if (node.enum !== undefined && node.enum.length > 0) {
    return { type: "enum", enumValues: node.enum.map((value) => String(value)) };
  }
  const type = node.type;
  if (type === "array") {
    const itemType = node.items?.type;
    return { type: typeof itemType === "string" ? `${itemType}[]` : "array" };
  }
  if (typeof type === "string") {
    return { type };
  }
  return { type: "unknown" };
}

function toKeyModel(
  node: JsonSchemaNode,
  segments: readonly string[],
  descriptions: Readonly<Record<string, string>>,
): ConfigKeyModel {
  const path = segments.join(".");
  const description = descriptions[path];
  if (description === undefined) {
    throw new Error(
      `Missing description for config key "${path}". Add it to CONFIG_DESCRIPTIONS in ` +
        "src/lib/reference/config-metadata.ts.",
    );
  }
  const { type, enumValues } = deriveType(node);
  return {
    path,
    segments,
    section: segments[0] ?? path,
    type,
    ...(enumValues !== undefined ? { enumValues } : {}),
    hasDefault: node.default !== undefined,
    ...(node.default !== undefined ? { default: node.default } : {}),
    ...(typeof node.minimum === "number" ? { min: node.minimum } : {}),
    ...(typeof node.maximum === "number" ? { max: node.maximum } : {}),
    description,
  };
}

/** Recursively collect leaf keys (nodes without nested `properties`). */
function collectLeaves(
  node: JsonSchemaNode,
  segments: readonly string[],
  descriptions: Readonly<Record<string, string>>,
): readonly ConfigKeyModel[] {
  if (node.properties !== undefined) {
    return Object.entries(node.properties).flatMap(([name, child]) =>
      collectLeaves(child, [...segments, name], descriptions),
    );
  }
  return [toKeyModel(node, segments, descriptions)];
}

/**
 * Convert a JSON Schema view of the Council `ConfigSchema` into a
 * {@link ConfigModel}.
 *
 * Top-level properties become sections; their nested properties are walked to
 * the leaves so every `config.yaml` setting appears with its dot path, type,
 * default, and constraints. Key order is preserved from the schema so the
 * serialised output is deterministic (and therefore drift-checkable). Throws if
 * any leaf key lacks a curated description.
 */
export function buildConfigModel(
  schema: JsonSchemaNode,
  descriptions: Readonly<Record<string, string>>,
  envVars: readonly EnvVarModel[],
): ConfigModel {
  const properties = schema.properties ?? {};
  const sections: readonly ConfigSectionModel[] = Object.entries(properties).map(
    ([name, node]) => ({
      name,
      description: descriptions[name] ?? "",
      keys: collectLeaves(node, [name], descriptions),
    }),
  );
  return {
    sections,
    keys: sections.flatMap((section) => section.keys),
    envVars: [...envVars],
  };
}
