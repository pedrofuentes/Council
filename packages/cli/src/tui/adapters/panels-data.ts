import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";

export interface PanelListItem {
  readonly name: string;
  readonly description: string;
  readonly memberCount: number;
  readonly source: "saved" | "template";
}

export interface PanelMemberView {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: "generic" | "persona";
}

export interface PanelDetailView {
  readonly name: string;
  readonly description: string;
  readonly source: "saved" | "template";
  readonly defaults?: {
    readonly mode?: string;
    readonly maxRounds?: number;
    readonly model?: string;
  };
  readonly members: readonly PanelMemberView[];
  readonly missing: readonly string[];
}

export interface PanelsRepos {
  readonly library: {
    findAll(): Promise<readonly { readonly name: string; readonly description: string | null }[]>;
    findByName(
      name: string,
    ): Promise<{ readonly name: string; readonly description: string | null } | undefined>;
    getMembers(name: string): Promise<readonly string[]>;
    getMemberCounts(): Promise<ReadonlyMap<string, number>>;
  };
  readonly experts: {
    get(slug: string): Promise<{
      readonly displayName: string;
      readonly role: string;
      readonly kind: "generic" | "persona";
    } | null>;
  };
  readonly listTemplates: () => Promise<readonly string[]>;
  readonly loadTemplate: (name: string) => Promise<{
    readonly description?: string;
    readonly defaults?: {
      readonly mode?: string | undefined;
      readonly maxRounds?: number | undefined;
      readonly model?: string | undefined;
    } | undefined;
    readonly experts: readonly {
      readonly slug: string;
      readonly displayName: string;
      readonly role: string;
      readonly kind: "generic" | "persona";
    }[];
  }>;
  /**
   * Optional warning sink (#2046). Invoked when template listing fails or an
   * individual template fails to load and the loader degrades to a partial (or
   * empty) template set. Falls back to `console.warn` when no sink is wired so
   * the degraded mode is never silently swallowed. Never affects control flow —
   * the list stays best-effort regardless of what the sink does.
   */
  readonly onWarning?: (message: string) => void;
}

export interface PanelsDataSource {
  readonly loadList: () => Promise<readonly PanelListItem[]>;
  readonly loadDetail: (
    name: string,
    source: "saved" | "template",
  ) => Promise<PanelDetailView | undefined>;
}

function mapTemplateDefaults(
  defaults:
    | {
        readonly mode?: string | undefined;
        readonly maxRounds?: number | undefined;
        readonly model?: string | undefined;
      }
    | undefined,
): PanelDetailView["defaults"] | undefined {
  if (defaults === undefined) return undefined;

  return {
    ...(defaults.mode === undefined ? {} : { mode: defaults.mode }),
    ...(defaults.maxRounds === undefined ? {} : { maxRounds: defaults.maxRounds }),
    ...(defaults.model === undefined ? {} : { model: defaults.model }),
  };
}

/**
 * Best-effort warning sink for the template loader (#2046). Routes to the
 * caller's {@link PanelsRepos.onWarning} when wired, else `console.warn`, so a
 * collapsed or partial template list is never silently swallowed. Template
 * names are file-derived and may embed terminal control sequences, so the whole
 * message is collapsed to a single sanitized line via {@link toSingleLineDisplay}
 * before it reaches the sink. Never throws — observability must not break the
 * best-effort list contract, so a throwing sink is swallowed.
 */
function warnPanelsData(onWarning: ((message: string) => void) | undefined, message: string): void {
  const safe = toSingleLineDisplay(message);
  try {
    if (onWarning) {
      onWarning(safe);
    } else {
      console.warn(safe);
    }
  } catch {
    // A broken warning sink must never degrade the best-effort list path.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * List the available template panels, isolating any listing/loading failure.
 *
 * #1817: an unguarded `listTemplates` (or `loadTemplate`) rejection used to
 * bubble out of {@link PanelsDataSource.loadList} and discard the
 * already-resolved saved panels the user does have. A template failure degrades
 * *only* this portion; the saved panels are still returned (and rendered) by
 * the caller.
 *
 * #2046: the fallback is no longer silent, nor all-or-nothing. Each template is
 * loaded independently with `Promise.allSettled`, so one hand-edited/malformed
 * template skips only *itself* instead of collapsing the entire template set
 * (the previous inner `Promise.all` short-circuited on the first rejection).
 * Both failure modes — a `listTemplates` rejection and any per-template
 * rejection — surface a discriminating warning through the injected
 * {@link PanelsRepos.onWarning} sink so template-subsystem corruption or a
 * loader regression is observable rather than masked.
 */
async function loadTemplateItems(repos: PanelsRepos): Promise<readonly PanelListItem[]> {
  let templateNames: readonly string[];
  try {
    templateNames = await repos.listTemplates();
  } catch (error) {
    warnPanelsData(
      repos.onWarning,
      `Could not list panel templates; hiding all templates: ${errorText(error)}`,
    );
    return [];
  }

  const settled = await Promise.allSettled(
    templateNames.map(async (name): Promise<PanelListItem> => {
      const template = await repos.loadTemplate(name);
      return {
        name,
        description: template.description ?? "",
        memberCount: template.experts.length,
        source: "template",
      };
    }),
  );

  const items: PanelListItem[] = [];
  const failedNames: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items.push(result.value);
      return;
    }
    failedNames.push(templateNames[index] ?? "<unknown>");
  });

  if (failedNames.length > 0) {
    warnPanelsData(
      repos.onWarning,
      `Skipped ${failedNames.length} of ${templateNames.length} panel template(s) that failed to load: ${failedNames.join(", ")}`,
    );
  }

  return items;
}

export function createPanelsDataSource(repos: PanelsRepos): PanelsDataSource {
  return {
    loadList: async (): Promise<readonly PanelListItem[]> => {
      const [savedPanels, memberCounts] = await Promise.all([
        repos.library.findAll(),
        repos.library.getMemberCounts(),
      ]);
      const savedItems = savedPanels.map(
        (panel): PanelListItem => ({
          name: panel.name,
          description: panel.description ?? "",
          memberCount: memberCounts.get(panel.name) ?? 0,
          source: "saved",
        }),
      );

      const templateItems = await loadTemplateItems(repos);

      return [...savedItems, ...templateItems];
    },
    loadDetail: async (
      name: string,
      source: "saved" | "template",
    ): Promise<PanelDetailView | undefined> => {
      if (source === "saved") {
        const panel = await repos.library.findByName(name);
        if (!panel) return undefined;

        const slugs = await repos.library.getMembers(name);
        const members: PanelMemberView[] = [];
        const missing: string[] = [];

        for (const slug of slugs) {
          const def = await repos.experts.get(slug);
          if (def) {
            members.push({
              slug,
              displayName: def.displayName,
              role: def.role,
              kind: def.kind,
            });
          } else {
            missing.push(slug);
          }
        }

        return {
          name: panel.name,
          description: panel.description ?? "",
          source,
          members,
          missing,
        };
      }

      const tpl = await repos.loadTemplate(name);
      const defaults = mapTemplateDefaults(tpl.defaults);
      return {
        name,
        description: tpl.description ?? "",
        source,
        ...(defaults === undefined ? {} : { defaults }),
        members: tpl.experts.map(
          (expert): PanelMemberView => ({
            slug: expert.slug,
            displayName: expert.displayName,
            role: expert.role,
            kind: expert.kind,
          }),
        ),
        missing: [],
      };
    },
  };
}
