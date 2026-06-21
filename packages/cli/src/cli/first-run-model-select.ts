import { createInterface } from "node:readline/promises";

import { updateConfigField } from "../config/index.js";
import { discoverAvailableModels, type ModelDiscoveryResult } from "../engine/copilot/health.js";
import type { ModelId } from "../engine/models.js";

import { CliUserError } from "./cli-user-error.js";
import { renderBanner } from "./renderers/banner.js";
import type { Writer } from "./commands/writer.js";

import packageJson from "../../package.json" with { type: "json" };

const MAX_SELECTION_ATTEMPTS = 3;
// Ranking hints for the model picker. Typed as `ModelId` so they are enforced
// at compile time to be members of the canonical SUPPORTED_MODELS registry,
// keeping the wizard in sync with the doctor/--model paths (bug F02).
const RECOMMENDED_MODEL: ModelId = "claude-sonnet-4.5";
const GPT_FALLBACK_MODEL: ModelId = "gpt-5.4";

/** The model the wizard recommends by default (member of SUPPORTED_MODELS). */
export const WIZARD_RECOMMENDED_MODEL: ModelId = RECOMMENDED_MODEL;
/** The GPT model the wizard prefers when ordering (member of SUPPORTED_MODELS). */
export const WIZARD_GPT_FALLBACK_MODEL: ModelId = GPT_FALLBACK_MODEL;

interface TtyReadableStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export interface SelectModelInteractivelyOptions {
  readonly write: Writer;
  readonly input?: TtyReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly discoverModels?: typeof discoverAvailableModels;
  readonly updateConfig?: typeof updateConfigField;
}

function getModelRank(model: string): number {
  if (model === RECOMMENDED_MODEL) {
    return 0;
  }
  if (model.startsWith("claude-sonnet-")) {
    return 1;
  }
  if (model === GPT_FALLBACK_MODEL) {
    return 2;
  }
  return 3;
}

function orderModelsByPreference(models: readonly string[]): readonly string[] {
  return [...new Set(models)].sort((left, right) => {
    const rankDifference = getModelRank(left) - getModelRank(right);
    return rankDifference !== 0 ? rankDifference : left.localeCompare(right);
  });
}

function isInteractiveInput(input: TtyReadableStream | undefined): boolean {
  const activeInput = input ?? process.stdin;
  return activeInput.isTTY === true;
}

function writeModelList(write: Writer, models: readonly string[]): void {
  write("Available models:\n");
  models.forEach((model, index) => {
    const recommendedSuffix = index === 0 ? " (recommended)" : "";
    write(`  ${index + 1}. ${model}${recommendedSuffix}\n`);
  });
  write("\n");
}

async function promptForModel(
  models: readonly string[],
  input: TtyReadableStream | undefined,
  output: NodeJS.WritableStream | undefined,
  write: Writer,
): Promise<string> {
  const activeOutput = output ?? process.stdout;
  const rl = createInterface({
    input: input ?? process.stdin,
    output: activeOutput,
    terminal: false,
  });
  const lines = rl[Symbol.asyncIterator]();

  try {
    for (let attempt = 1; attempt <= MAX_SELECTION_ATTEMPTS; attempt += 1) {
      activeOutput.write(`Select a model [1-${models.length}] (Enter for recommended): `);
      const nextLine = await lines.next();
      const trimmed = (nextLine.done ? "" : nextLine.value).trim();

      if (trimmed.length === 0) {
        return models[0] ?? RECOMMENDED_MODEL;
      }

      if (/^\d+$/.test(trimmed)) {
        const selectedIndex = Number.parseInt(trimmed, 10) - 1;
        const selectedModel = models[selectedIndex];
        if (selectedModel !== undefined) {
          return selectedModel;
        }
      }

      if (attempt === MAX_SELECTION_ATTEMPTS) {
        write("Too many invalid selections; using the recommended model.\n");
        return models[0] ?? RECOMMENDED_MODEL;
      }

      write(
        `Invalid selection. Enter a number between 1 and ${models.length}, or press Enter for the recommended model.\n`,
      );
    }
  } finally {
    rl.close();
  }

  return models[0] ?? RECOMMENDED_MODEL;
}

function throwNoModelsAvailable(write: Writer): never {
  const message = "No AI models are available. Run 'council doctor' to verify your full setup.";
  write(`Error: ${message}\n`);
  throw new CliUserError(message);
}

function writeSelectionConfirmation(write: Writer, selectedModel: string): void {
  write(`✓ Default model set to ${selectedModel}\n\n`);
  write("Run 'council doctor' to verify your full setup.\n");
}

export async function selectModelInteractively(
  options: SelectModelInteractivelyOptions,
): Promise<string> {
  const write = options.write;
  const discoverModels = options.discoverModels ?? discoverAvailableModels;
  const persistConfig = options.updateConfig ?? updateConfigField;

  write(`${renderBanner({ version: packageJson.version })}\n\n`);
  write("Welcome to Council! Let's set up your default AI model.\n\n");
  write("Discovering available models...\n\n");

  const discovery: ModelDiscoveryResult = await discoverModels();
  const models = orderModelsByPreference(discovery.models);

  if (discovery.source === "static") {
    write("Warning: Live model discovery failed, so Council is showing a built-in fallback list.\n\n");
  }

  if (models.length === 0) {
    throwNoModelsAvailable(write);
  }

  const recommendedModel = models[0];
  if (recommendedModel === undefined) {
    throwNoModelsAvailable(write);
  }

  writeModelList(write, models);

  const interactive = isInteractiveInput(options.input);
  const selectedModel = interactive
    ? await promptForModel(models, options.input, options.output, write)
    : recommendedModel;

  if (!interactive) {
    write(`Non-interactive session detected; using recommended model ${selectedModel}.\n`);
  }

  await persistConfig("defaults.model", selectedModel);
  writeSelectionConfirmation(write, selectedModel);

  return selectedModel;
}
