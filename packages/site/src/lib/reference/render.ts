/**
 * Render a {@link CommandModel} tree into the committed documentation
 * artifacts: one Starlight markdown page per top-level command, an index page,
 * and a machine-readable `commands.json`.
 *
 * Pure and deterministic: given the same model it always produces byte-for-byte
 * identical output, which is what lets `docs:check:commands` detect drift. All
 * CLI help text is treated as literal and markdown-escaped so placeholders like
 * `<kind>` and emphasis like `**Omit**` render verbatim instead of being
 * interpreted as HTML or markdown.
 */
import type { CommandArgumentModel, CommandModel, CommandOptionModel } from "./command-model";

export interface GeneratedFile {
  /** Path relative to the `packages/site` package root. */
  readonly path: string;
  readonly contents: string;
}

export const GENERATED_FILE_WARNING =
  "DO NOT EDIT — this file is auto-generated from the Council CLI's Commander " +
  "definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run " +
  "that command to regenerate it, and `pnpm --filter @council-ai/site " +
  "docs:check:commands` to verify it is in sync.";

const COMMANDS_DOC_DIR = "src/content/docs/reference/commands";
const COMMANDS_JSON_PATH = "src/generated/commands.json";

/**
 * Markdown-escape literal inline text: collapse whitespace and backslash-escape
 * the characters that would otherwise be parsed as markdown/HTML.
 */
function escapeInline(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]<>|~])/g, "\\$1");
}

function inlineCode(text: string): string {
  return `\`${text}\``;
}

function formatDefault(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return inlineCode(text);
}

function summaryLine(command: CommandModel): string {
  const source = command.summary ?? command.description;
  const collapsed = source.replace(/\s+/g, " ").trim();
  const match = /^(.*?[.!?])(?:\s|$)/.exec(collapsed);
  return match?.[1] ?? collapsed;
}

function renderChoices(choices: readonly string[]): string {
  return ` (choices: ${choices.map(inlineCode).join(", ")})`;
}

function renderArgumentsTable(args: readonly CommandArgumentModel[]): string {
  const rows = args.map((argument) => {
    const description =
      escapeInline(argument.description) +
      (argument.choices !== undefined && argument.choices.length > 0
        ? renderChoices(argument.choices)
        : "");
    const defaultCell =
      argument.defaultValue !== undefined ? formatDefault(argument.defaultValue) : "—";
    return `| ${inlineCode(argument.display)} | ${description} | ${defaultCell} |`;
  });
  return ["| Argument | Description | Default |", "| --- | --- | --- |", ...rows].join("\n");
}

function renderOptionsTable(options: readonly CommandOptionModel[]): string {
  const rows = options.map((option) => {
    const description =
      escapeInline(option.description) +
      (option.choices !== undefined && option.choices.length > 0
        ? renderChoices(option.choices)
        : "");
    const defaultCell =
      option.defaultValue !== undefined ? formatDefault(option.defaultValue) : "—";
    return `| ${inlineCode(option.flags)} | ${description} | ${defaultCell} |`;
  });
  return ["| Option | Description | Default |", "| --- | --- | --- |", ...rows].join("\n");
}

function renderUsageBlock(command: CommandModel): string {
  const suffix = command.usage.length > 0 ? ` ${command.usage}` : "";
  return ["```text", `${command.commandPath}${suffix}`, "```"].join("\n");
}

function renderAliases(command: CommandModel): string {
  return `**Aliases:** ${command.aliases.map(inlineCode).join(", ")}`;
}

/** Detail blocks (usage/aliases/arguments/options) shared by every command. */
function renderCommandDetails(command: CommandModel, label: (text: string) => string): string[] {
  const blocks: string[] = [`${label("Usage")}\n\n${renderUsageBlock(command)}`];
  if (command.aliases.length > 0) {
    blocks.push(renderAliases(command));
  }
  if (command.arguments.length > 0) {
    blocks.push(`${label("Arguments")}\n\n${renderArgumentsTable(command.arguments)}`);
  }
  if (command.options.length > 0) {
    blocks.push(`${label("Options")}\n\n${renderOptionsTable(command.options)}`);
  }
  return blocks;
}

/** Render a subcommand (any depth) with a heading and bold-labelled details. */
function renderSubcommand(command: CommandModel, level: number): string {
  const heading = "#".repeat(Math.min(level, 6));
  const blocks: string[] = [`${heading} ${command.commandPath}`];
  if (command.description.length > 0) {
    blocks.push(escapeInline(command.description));
  }
  blocks.push(...renderCommandDetails(command, (text) => `**${text}**`));
  for (const child of command.subcommands) {
    blocks.push(renderSubcommand(child, level + 1));
  }
  return blocks.join("\n\n");
}

function renderFrontmatter(title: string, description: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n`;
}

function renderCommandPage(command: CommandModel): GeneratedFile {
  const blocks: string[] = [`> ${GENERATED_FILE_WARNING}`];
  if (command.description.length > 0) {
    blocks.push(escapeInline(command.description));
  }
  blocks.push(...renderCommandDetails(command, (text) => `## ${text}`));
  if (command.subcommands.length > 0) {
    blocks.push("## Subcommands");
    for (const subcommand of command.subcommands) {
      blocks.push(renderSubcommand(subcommand, 3));
    }
  }
  const frontmatter = renderFrontmatter(command.commandPath, summaryLine(command));
  return {
    path: `${COMMANDS_DOC_DIR}/${command.name}.md`,
    contents: `${frontmatter}\n${blocks.join("\n\n")}\n`,
  };
}

function renderIndexPage(root: CommandModel): GeneratedFile {
  const tableRows = root.subcommands.map((command) => {
    const link = `[${inlineCode(command.commandPath)}](./${command.name}/)`;
    return `| ${link} | ${escapeInline(summaryLine(command))} |`;
  });
  const blocks: string[] = [`> ${GENERATED_FILE_WARNING}`];
  if (root.description.length > 0) {
    blocks.push(escapeInline(root.description));
  }
  blocks.push(
    ["## Commands", "", "| Command | Description |", "| --- | --- |", ...tableRows].join("\n"),
  );
  if (root.options.length > 0) {
    blocks.push(`## Global options\n\n${renderOptionsTable(root.options)}`);
  }
  const frontmatter = renderFrontmatter(
    "Command Reference",
    "Every Council CLI command, generated from the CLI's own Commander definitions.",
  );
  return {
    path: `${COMMANDS_DOC_DIR}/index.md`,
    contents: `${frontmatter}\n${blocks.join("\n\n")}\n`,
  };
}

function renderJson(root: CommandModel): GeneratedFile {
  const payload = {
    $generated: GENERATED_FILE_WARNING,
    $source: "@council-ai/cli buildProgram()",
    command: root,
  };
  return { path: COMMANDS_JSON_PATH, contents: `${JSON.stringify(payload, null, 2)}\n` };
}

/**
 * Produce every generated file for the command reference: the index page, one
 * page per top-level command, and the serialised JSON model.
 */
export function renderReference(root: CommandModel): readonly GeneratedFile[] {
  const files: GeneratedFile[] = [renderIndexPage(root)];
  for (const command of root.subcommands) {
    files.push(renderCommandPage(command));
  }
  files.push(renderJson(root));
  return files;
}
