/**
 * A serialisable, CLI-agnostic model of a Commander command tree.
 *
 * The Council CLI builds its Commander program in `buildProgram()`
 * (`@council-ai/cli`). This module walks that program through Commander's
 * public introspection surface and produces a plain, JSON-friendly model that
 * the documentation generator renders into markdown + JSON. Keeping the model
 * here — with only structural source types and no `commander` import — means
 * the site never bundles the CLI: the model is data, and the CLI is only
 * touched by the build-time scripts that feed real Commander objects in.
 */

/** Structural view of the subset of a Commander `Argument` we read. */
export interface ArgumentSource {
  name(): string;
  readonly description: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly defaultValue?: unknown;
  readonly argChoices?: readonly string[];
}

/** Structural view of the subset of a Commander `Option` we read. */
export interface OptionSource {
  readonly flags: string;
  readonly description: string;
  readonly long?: string;
  readonly short?: string;
  readonly required: boolean;
  readonly optional: boolean;
  readonly variadic: boolean;
  readonly negate: boolean;
  readonly hidden: boolean;
  readonly defaultValue?: unknown;
  readonly defaultValueDescription?: string;
  readonly argChoices?: readonly string[];
}

/** Structural view of the subset of a Commander `Command` we read. */
export interface CommandSource {
  name(): string;
  description(): string;
  summary(): string;
  aliases(): readonly string[];
  usage(): string;
  readonly registeredArguments: readonly ArgumentSource[];
  readonly options: readonly OptionSource[];
  readonly commands: readonly CommandSource[];
}

export interface CommandArgumentModel {
  /** Bare argument name, e.g. `topic`. */
  readonly name: string;
  /** Help-style display form, e.g. `[topic]`, `<name>`, `[slugs...]`. */
  readonly display: string;
  readonly description: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly defaultValue?: unknown;
  readonly choices?: readonly string[];
}

export interface CommandOptionModel {
  /** Raw flag spec, e.g. `--engine <kind>` or `-p, --panel <name>`. */
  readonly flags: string;
  readonly description: string;
  readonly long?: string;
  readonly short?: string;
  readonly required: boolean;
  readonly optional: boolean;
  readonly variadic: boolean;
  readonly negate: boolean;
  readonly defaultValue?: unknown;
  readonly defaultValueDescription?: string;
  readonly choices?: readonly string[];
}

export interface CommandModel {
  /** Bare command name, e.g. `convene` or `create`. */
  readonly name: string;
  /** Path of names from the root program, e.g. `["council", "panel", "create"]`. */
  readonly path: readonly string[];
  /** Space-joined invocation path, e.g. `council panel create`. */
  readonly commandPath: string;
  readonly description: string;
  readonly summary?: string;
  readonly aliases: readonly string[];
  /** Commander usage suffix, e.g. `[options] [topic]`. */
  readonly usage: string;
  readonly arguments: readonly CommandArgumentModel[];
  readonly options: readonly CommandOptionModel[];
  readonly subcommands: readonly CommandModel[];
}

function formatArgumentDisplay(name: string, required: boolean, variadic: boolean): string {
  const inner = variadic ? `${name}...` : name;
  return required ? `<${inner}>` : `[${inner}]`;
}

function toArgumentModel(argument: ArgumentSource): CommandArgumentModel {
  const name = argument.name();
  return {
    name,
    display: formatArgumentDisplay(name, argument.required, argument.variadic),
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
    ...(argument.defaultValue !== undefined ? { defaultValue: argument.defaultValue } : {}),
    ...(argument.argChoices !== undefined ? { choices: [...argument.argChoices] } : {}),
  };
}

function toOptionModel(option: OptionSource): CommandOptionModel {
  return {
    flags: option.flags,
    description: option.description,
    ...(option.long !== undefined ? { long: option.long } : {}),
    ...(option.short !== undefined ? { short: option.short } : {}),
    required: option.required,
    optional: option.optional,
    variadic: option.variadic,
    negate: option.negate,
    ...(option.defaultValue !== undefined ? { defaultValue: option.defaultValue } : {}),
    ...(option.defaultValueDescription !== undefined
      ? { defaultValueDescription: option.defaultValueDescription }
      : {}),
    ...(option.argChoices !== undefined ? { choices: [...option.argChoices] } : {}),
  };
}

/**
 * Recursively convert a Commander command into a {@link CommandModel}.
 *
 * Hidden options are dropped so the reference matches `--help`. Command,
 * argument, and option order is preserved from the Commander definitions so
 * the serialised output is deterministic (and therefore drift-checkable).
 */
export function buildCommandModel(
  command: CommandSource,
  parentPath: readonly string[] = [],
): CommandModel {
  const path = [...parentPath, command.name()];
  const summary = command.summary();

  return {
    name: command.name(),
    path,
    commandPath: path.join(" "),
    description: command.description(),
    ...(summary !== "" ? { summary } : {}),
    aliases: [...command.aliases()],
    usage: command.usage(),
    arguments: command.registeredArguments.map(toArgumentModel),
    options: command.options.filter((option) => !option.hidden).map(toOptionModel),
    subcommands: command.commands.map((subcommand) => buildCommandModel(subcommand, path)),
  };
}
