import * as readline from "node:readline/promises";

import {
  loadPanel,
  listTemplates,
  listUserPanels,
  PanelNotFoundError,
  TEMPLATE_NAME_PATTERN,
} from "../core/template-loader.js";
import type { CouncilDatabase } from "../memory/db.js";
import { DebateRepository } from "../memory/repositories/debates.js";
import { type Panel, PanelRepository } from "../memory/repositories/panels.js";

import { CliUserError } from "./cli-user-error.js";
import { suggestMatch } from "./fuzzy-match.js";
import { isNonInteractive as defaultIsNonInteractive } from "./non-interactive.js";

export interface SessionMatch {
  readonly name: string;
  readonly topic: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SessionPicker = (matches: readonly SessionMatch[]) => Promise<SessionMatch>;

type ErrorWriter = (chunk: string) => void;

export interface ResolveSessionOptions {
  readonly db: CouncilDatabase;
  readonly dataHome: string;
  readonly panelArg?: string | undefined;
  readonly latest?: boolean;
  readonly writeError?: ErrorWriter;
  readonly isNonInteractive?: () => boolean;
  readonly picker?: SessionPicker | undefined;
  readonly missingPanelMode?: "error" | "most-recently-debated";
  readonly missingPanelMessage?: string;
}

export async function resolveSession(options: ResolveSessionOptions): Promise<string> {
  const writeError = options.writeError ?? (() => undefined);
  const panelRepo = new PanelRepository(options.db);

  if (options.latest === true) {
    const latestPanel = await panelRepo.findMostRecentlyActive();
    if (!latestPanel) {
      const message = "No panels found. Run `council convene` to start one.";
      writeError(message + "\n");
      throw new CliUserError(message);
    }
    return latestPanel.name;
  }

  const requested = options.panelArg?.trim();
  if (!requested) {
    return resolveMissingPanelArg(options, writeError);
  }

  const exactMatch = await panelRepo.findByName(requested);
  if (exactMatch) return exactMatch.name;

  const prefixMatches = await panelRepo.findByNamePrefix(requested);
  if (prefixMatches.length === 1) {
    const onlyMatch = prefixMatches[0];
    if (onlyMatch) return onlyMatch.name;
  }
  if (prefixMatches.length > 1) {
    const selected = await resolveAmbiguousPrefix({
      requested,
      matches: prefixMatches.map(toSessionMatch),
      writeError,
      isNonInteractive: options.isNonInteractive ?? defaultIsNonInteractive,
      picker: options.picker,
    });
    return selected.name;
  }

  if (await panelTemplateExists(requested, options.dataHome)) {
    const message =
      `Panel '${requested}' exists but has no debates yet. ` +
      `Run \`council convene --template ${requested}\` first.`;
    writeError(message + "\n");
    throw new CliUserError(message);
  }

  const suggestions = await buildSuggestions(panelRepo, options.dataHome, requested);
  const suggestionText =
    suggestions.length === 0
      ? ""
      : ` Did you mean ${suggestions.map((value) => `'${value}'`).join(", ")}?`;
  const message =
    `No panel found matching '${requested}'.${suggestionText} ` +
    "Run `council sessions` to list available panels.";
  writeError(message + "\n");
  throw new CliUserError(message);
}

async function resolveMissingPanelArg(
  options: ResolveSessionOptions,
  writeError: ErrorWriter,
): Promise<string> {
  if (options.missingPanelMode === "most-recently-debated") {
    const panel = await findMostRecentlyDebatedPanel(options.db);
    if (!panel) {
      const message =
        "No panels with debates found in the local database. Run `council convene` first.";
      writeError(message + "\n");
      throw new CliUserError(message);
    }
    writeError(`Using panel: ${panel.name}\n`);
    return panel.name;
  }

  const message =
    options.missingPanelMessage ??
    "Panel name is required. Use `council resume <name>` or `council resume --latest`.";
  writeError(message + "\n");
  throw new CliUserError(message);
}

async function resolveAmbiguousPrefix(args: {
  readonly requested: string;
  readonly matches: readonly SessionMatch[];
  readonly writeError: ErrorWriter;
  readonly isNonInteractive: () => boolean;
  readonly picker?: SessionPicker | undefined;
}): Promise<SessionMatch> {
  if (args.isNonInteractive()) {
    writeAmbiguousMatches(args.requested, args.matches, args.writeError);
    args.writeError(
      `Run \`council resume <name>\` with the full name of one of the panels above to disambiguate.\n`,
    );
    throw new CliUserError(
      `Ambiguous prefix '${args.requested}' matches ${args.matches.length} panels.`,
    );
  }

  const picker =
    args.picker ?? ((matches: readonly SessionMatch[]) => defaultPicker(args.requested, matches));
  return picker(args.matches);
}

async function defaultPicker(
  requested: string,
  matches: readonly SessionMatch[],
): Promise<SessionMatch> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    writeAmbiguousMatches(requested, matches, (chunk) => {
      process.stderr.write(chunk);
    });
    while (true) {
      const answer = await rl.question(`Select a panel [1-${matches.length}] (Enter to cancel): `);
      const trimmed = answer.trim();
      if (trimmed.length === 0) {
        throw new CliUserError("Panel selection cancelled.");
      }
      if (/^\d+$/.test(trimmed)) {
        const index = Number.parseInt(trimmed, 10) - 1;
        const match = matches[index];
        if (match) return match;
      }
      process.stderr.write(`Please enter a number between 1 and ${matches.length}.\n`);
    }
  } finally {
    rl.close();
  }
}

function writeAmbiguousMatches(
  requested: string,
  matches: readonly SessionMatch[],
  writeError: ErrorWriter,
): void {
  writeError(`Multiple panels match "${requested}":\n`);
  for (const [index, match] of matches.entries()) {
    writeError(`  ${index + 1}. ${formatSessionMatch(match)}\n`);
  }
}

function formatSessionMatch(match: SessionMatch): string {
  const topic = match.topic ?? "No topic";
  return `${match.name} | ${topic} | ${match.createdAt}`;
}

function toSessionMatch(panel: Panel): SessionMatch {
  return {
    name: panel.name,
    topic: panel.topic,
    createdAt: panel.createdAt,
    updatedAt: panel.updatedAt,
  };
}

async function panelTemplateExists(name: string, dataHome: string): Promise<boolean> {
  if (!TEMPLATE_NAME_PATTERN.test(name)) return false;
  try {
    await loadPanel(name, dataHome);
    return true;
  } catch (err: unknown) {
    if (err instanceof PanelNotFoundError) return false;
    throw err;
  }
}

async function buildSuggestions(
  panelRepo: PanelRepository,
  dataHome: string,
  requested: string,
): Promise<readonly string[]> {
  const [panels, userPanels, builtInTemplates] = await Promise.all([
    panelRepo.findAll(),
    listUserPanels(dataHome),
    listTemplates(),
  ]);
  const candidates = [
    ...new Set([...panels.map((panel) => panel.name), ...userPanels, ...builtInTemplates]),
  ];
  return suggestMatch(requested, candidates);
}

async function findMostRecentlyDebatedPanel(db: CouncilDatabase): Promise<Panel | undefined> {
  const panelRepo = new PanelRepository(db);
  const debateRepo = new DebateRepository(db);
  const panels = await panelRepo.findAll();
  if (panels.length === 0) return undefined;

  let bestPanel: Panel | undefined;
  let bestStartedAt: string | undefined;

  for (const panel of panels) {
    const debates = await debateRepo.findByPanelId(panel.id);
    const latestDebate = debates[debates.length - 1];
    if (!latestDebate) continue;
    if (bestStartedAt === undefined || latestDebate.startedAt > bestStartedAt) {
      bestStartedAt = latestDebate.startedAt;
      bestPanel = panel;
    }
  }

  return bestPanel;
}
