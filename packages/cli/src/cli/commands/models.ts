/**
 * `council models` — list available Copilot models.
 */
import { Command } from "commander";

import { discoverAvailableModels, type ModelDiscoveryResult } from "../../engine/copilot/health.js";
import { stripControlChars } from "../strip-control-chars.js";

import { defaultWriter, type Writer } from "./writer.js";

const MODEL_GROUPS = [
  { label: "Anthropic", prefix: "claude-" },
  { label: "OpenAI", prefix: "gpt-" },
  { label: "Google", prefix: "gemini-" },
] as const;

/** Bucket for routable ids that don't match a provider prefix (e.g. `auto`). */
const OTHER_GROUP_LABEL = "Other";

export interface ModelsDeps {
  readonly write?: Writer;
  readonly discoverModels?: () => Promise<ModelDiscoveryResult>;
}

function sanitizeModelId(id: string): string {
  return stripControlChars(id)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function isValidModelId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
}

/**
 * Format the list of available models grouped by provider.
 * Exported for reuse by `doctor --models` and direct testing.
 */
export function formatAvailableModels(
  models: readonly string[],
  source: "live" | "static",
): string {
  const orderedModels = [
    ...new Set(
      models.map(sanitizeModelId).filter((model) => model.length > 0 && isValidModelId(model)),
    ),
  ];

  const labelWidth = Math.max(
    OTHER_GROUP_LABEL.length,
    ...MODEL_GROUPS.map((group) => group.label.length),
  );
  const header =
    source === "live" ? "Available models:" : "Known models (live discovery unavailable):";

  let output = `${header}\n`;

  for (const group of MODEL_GROUPS) {
    const groupedModels = orderedModels.filter((model) => model.startsWith(group.prefix));
    if (groupedModels.length === 0) {
      continue;
    }
    output += `  ${group.label.padEnd(labelWidth, " ")}: ${groupedModels.join(", ")}\n`;
  }

  // Surface routable ids that don't match a provider prefix (e.g. the `auto`
  // selector or internal models) so `council models` / `doctor --models`
  // advertise everything `convene --model` accepts (bug PM-03).
  const ungroupedModels = orderedModels.filter(
    (model) => !MODEL_GROUPS.some((group) => model.startsWith(group.prefix)),
  );
  if (ungroupedModels.length > 0) {
    output += `  ${OTHER_GROUP_LABEL.padEnd(labelWidth, " ")}: ${ungroupedModels.join(", ")}\n`;
  }

  output += "\n";
  output +=
    "Note: Known models: Availability depends on your Copilot tier. Use 'council doctor' to verify your default model is accessible.\n";

  return output;
}

function isWriter(input: ModelsDeps | Writer): input is Writer {
  return typeof input === "function";
}

function resolveModelsDeps(input: ModelsDeps | Writer): Required<ModelsDeps> {
  const deps = isWriter(input) ? { write: input } : input;
  return {
    write: deps.write ?? defaultWriter,
    discoverModels: deps.discoverModels ?? discoverAvailableModels,
  };
}

export function buildModelsCommand(input: ModelsDeps | Writer = {}): Command {
  const { write, discoverModels } = resolveModelsDeps(input);
  const cmd = new Command("models");
  cmd
    .description("List available Copilot models (live discovery with static fallback)")
    .action(async () => {
      const modelDiscovery = await discoverModels();
      write(formatAvailableModels(modelDiscovery.models, modelDiscovery.source));
    });
  return cmd;
}
