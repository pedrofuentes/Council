import type { SpeakerKind } from "../../memory/repositories/turns.js";

export type SessionStatus = "running" | "completed" | "interrupted" | "aborted" | "failed" | "none";

export interface SessionListItem {
  readonly panelId: string;
  readonly panelName: string;
  readonly topic: string;
  readonly debateCount: number;
  readonly turnCount: number;
  readonly latestStatus: SessionStatus;
  readonly updatedAt: string;
}

export interface SessionsRepos {
  readonly panels: {
    findAll(): Promise<
      readonly {
        readonly id: string;
        readonly name: string;
        readonly topic: string | null;
        readonly updatedAt: string;
      }[]
    >;
  };
  readonly debates: {
    findByPanelId(panelId: string): Promise<
      readonly {
        readonly id: string;
        readonly status: Exclude<SessionStatus, "none">;
        readonly startedAt: string;
      }[]
    >;
  };
  readonly turns: {
    countByDebateId(debateId: string): Promise<number>;
  };
}

export interface TranscriptLine {
  readonly speaker: string;
  readonly round: number;
  readonly content: string;
  readonly kind: SpeakerKind;
}

export interface SessionTranscriptView {
  readonly panelName: string;
  readonly topic: string;
  readonly prompt: string;
  readonly status: string;
  readonly lines: readonly TranscriptLine[];
}

export interface TranscriptDoc {
  readonly panel: { readonly name: string; readonly topic: string | null };
  readonly experts: readonly {
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
  }[];
  readonly latestDebate: { readonly prompt: string; readonly status: string };
  readonly turns: readonly {
    readonly expertId: string | null;
    readonly round: number;
    readonly content: string;
    readonly speakerKind: SpeakerKind;
  }[];
}

export interface SessionsTranscriptLoader {
  readonly loadTranscript: (panelName: string) => Promise<TranscriptDoc | undefined>;
}

export interface SessionsDataSource {
  readonly loadList: () => Promise<readonly SessionListItem[]>;
  readonly loadTranscript: (panelName: string) => Promise<SessionTranscriptView | undefined>;
}

export function sessionStatusSymbol(status: SessionStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "running":
      return "…";
    case "none":
      return "·";
    default:
      return "⚠";
  }
}

export function createSessionsDataSource(
  repos: SessionsRepos & SessionsTranscriptLoader,
): SessionsDataSource {
  return {
    loadList: async (): Promise<readonly SessionListItem[]> => {
      const panels = await repos.panels.findAll();
      const items = await Promise.all(
        panels.map(async (panel): Promise<SessionListItem> => {
          const debates = await repos.debates.findByPanelId(panel.id);
          const turnCounts = await Promise.all(
            debates.map(async (debate): Promise<number> => repos.turns.countByDebateId(debate.id)),
          );
          const turnCount = turnCounts.reduce((total, count) => total + count, 0);
          const latest = [...debates].sort((left, right) =>
            right.startedAt.localeCompare(left.startedAt),
          )[0];

          return {
            panelId: panel.id,
            panelName: panel.name,
            topic: panel.topic ?? "",
            debateCount: debates.length,
            turnCount,
            latestStatus: latest?.status ?? "none",
            updatedAt: panel.updatedAt,
          };
        }),
      );

      return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    loadTranscript: async (panelName: string): Promise<SessionTranscriptView | undefined> => {
      const doc = await repos.loadTranscript(panelName);
      if (doc === undefined) return undefined;

      const byId = new Map(doc.experts.map((expert) => [expert.id, expert] as const));
      const lines = doc.turns.map((turn): TranscriptLine => {
        const expert = turn.expertId !== null ? byId.get(turn.expertId) : undefined;
        const speaker =
          expert !== undefined
            ? expert.displayName !== ""
              ? expert.displayName
              : expert.slug
            : turn.speakerKind;

        return {
          speaker,
          round: turn.round,
          content: turn.content,
          kind: turn.speakerKind,
        };
      });

      return {
        panelName: doc.panel.name,
        topic: doc.panel.topic ?? "",
        prompt: doc.latestDebate.prompt,
        status: doc.latestDebate.status,
        lines,
      };
    },
  };
}
