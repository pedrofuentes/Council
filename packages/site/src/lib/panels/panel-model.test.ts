import { describe, expect, it } from "vitest";

import {
  DISCIPLINES,
  buildConveneCommand,
  disciplineOf,
  groupByDiscipline,
  humanizePanelName,
  regulatedDomainBadge,
  toPanelSummary,
  type PanelSummary,
  type RawPanel,
} from "./panel-model";

/** Build a minimal raw panel for tests, overriding only what a case cares about. */
function rawPanel(overrides: Partial<RawPanel> = {}): RawPanel {
  return {
    name: "code-review",
    description: "A multi-perspective review.",
    experts: [
      { slug: "a", displayName: "Expert A", role: "Role A" },
      { slug: "b", displayName: "Expert B", role: "Role B" },
    ],
    ...overrides,
  };
}

describe("humanizePanelName", () => {
  it("title-cases a hyphenated slug", () => {
    expect(humanizePanelName("code-review")).toBe("Code Review");
    expect(humanizePanelName("career-coaching")).toBe("Career Coaching");
    expect(humanizePanelName("executive-strategy-board-prep")).toBe(
      "Executive Strategy Board Prep",
    );
  });

  it("expands known acronyms to their canonical casing", () => {
    expect(humanizePanelName("fpna-budget-review")).toBe("FP&A Budget Review");
    expect(humanizePanelName("ux-review")).toBe("UX Review");
  });
});

describe("disciplineOf", () => {
  it("classifies engineering panels from their slug", () => {
    expect(disciplineOf({ slug: "code-review" })).toBe("Engineering");
    expect(disciplineOf({ slug: "architecture-review" })).toBe("Engineering");
    expect(disciplineOf({ slug: "incident-postmortem" })).toBe("Engineering");
  });

  it("classifies startup & career panels from their slug", () => {
    expect(disciplineOf({ slug: "startup-validation" })).toBe("Startup & Career");
    expect(disciplineOf({ slug: "career-coaching" })).toBe("Startup & Career");
  });

  it("classifies product & design panels from their tags", () => {
    expect(disciplineOf({ slug: "product-strategy-review", tags: ["product", "strategy"] })).toBe(
      "Product & Design",
    );
    expect(
      disciplineOf({ slug: "roadmap-prioritization", tags: ["product", "prioritization"] }),
    ).toBe("Product & Design");
    expect(disciplineOf({ slug: "ux-review", tags: ["design", "ux"] })).toBe("Product & Design");
  });

  it("classifies go-to-market panels from their tags", () => {
    expect(
      disciplineOf({
        slug: "brand-positioning-review",
        tags: ["marketing", "brand", "positioning", "go-to-market"],
      }),
    ).toBe("Go-to-market");
    expect(
      disciplineOf({ slug: "negotiation-prep", tags: ["negotiation", "deals", "go-to-market"] }),
    ).toBe("Go-to-market");
    expect(
      disciplineOf({ slug: "growth-experiment-review", tags: ["growth", "experimentation"] }),
    ).toBe("Go-to-market");
  });

  it("classifies regulated panels into Finance, People, Legal & Exec", () => {
    expect(
      disciplineOf({ slug: "legal-risk-review", tags: ["legal"], regulatedDomain: "legal" }),
    ).toBe("Finance, People, Legal & Exec");
    expect(disciplineOf({ slug: "fpna-budget-review", regulatedDomain: "finance" })).toBe(
      "Finance, People, Legal & Exec",
    );
    expect(disciplineOf({ slug: "hiring-decision-review", regulatedDomain: "hr" })).toBe(
      "Finance, People, Legal & Exec",
    );
  });

  it("classifies executive panels from their tags without a regulated domain", () => {
    expect(
      disciplineOf({
        slug: "executive-strategy-board-prep",
        tags: ["executive", "strategy", "board", "leadership"],
      }),
    ).toBe("Finance, People, Legal & Exec");
  });
});

describe("buildConveneCommand", () => {
  it("uses the --panel flag with a quoted placeholder topic", () => {
    expect(buildConveneCommand("legal-risk-review")).toBe(
      'council convene "<your topic>" --panel legal-risk-review',
    );
  });

  it("passes the panel via --panel, never as a positional argument", () => {
    const command = buildConveneCommand("product-strategy-review");
    expect(command).toContain("--panel product-strategy-review");
    // The slug must only appear after the flag, not as a bare positional.
    expect(command).not.toMatch(/convene "[^"]*" product-strategy-review/);
  });
});

describe("regulatedDomainBadge", () => {
  it("labels each regulated domain as decision-support", () => {
    expect(regulatedDomainBadge("finance")).toEqual({ domain: "finance", label: "Finance" });
    expect(regulatedDomainBadge("hr")).toEqual({ domain: "hr", label: "People (HR)" });
    expect(regulatedDomainBadge("legal")).toEqual({ domain: "legal", label: "Legal" });
  });
});

describe("toPanelSummary", () => {
  it("maps a fully-populated panel and normalizes folded-scalar whitespace", () => {
    const summary = toPanelSummary("legal-risk-review", {
      name: "legal-risk-review",
      description: "Reviews a contract\nbefore commitment.\n",
      experts: [
        { slug: "counsel", displayName: "Eleanor Voss (General Counsel)", role: "General counsel" },
        { slug: "commercial", displayName: "Raj Malhotra", role: "Commercial lead" },
      ],
      samplePrompts: ["What is our real\nexposure here?\n"],
      decisionArtifact: "A go, hold, or mitigate\nrecommendation.\n",
      tags: ["legal", "risk", "compliance"],
      regulatedDomain: "legal",
    });

    expect(summary.slug).toBe("legal-risk-review");
    expect(summary.name).toBe("Legal Risk Review");
    expect(summary.description).toBe("Reviews a contract before commitment.");
    expect(summary.discipline).toBe("Finance, People, Legal & Exec");
    expect(summary.tags).toEqual(["legal", "risk", "compliance"]);
    expect(summary.experts).toEqual([
      { slug: "counsel", displayName: "Eleanor Voss (General Counsel)", role: "General counsel" },
      { slug: "commercial", displayName: "Raj Malhotra", role: "Commercial lead" },
    ]);
    expect(summary.expertCount).toBe(2);
    expect(summary.samplePrompts).toEqual(["What is our real exposure here?"]);
    expect(summary.decisionArtifact).toBe("A go, hold, or mitigate recommendation.");
    expect(summary.regulatedDomain).toEqual({ domain: "legal", label: "Legal" });
    expect(summary.conveneCommand).toBe('council convene "<your topic>" --panel legal-risk-review');
  });

  it("handles legacy panels without tags, prompts, artifact, or regulated domain", () => {
    const summary = toPanelSummary("code-review", rawPanel());

    expect(summary.name).toBe("Code Review");
    expect(summary.discipline).toBe("Engineering");
    expect(summary.tags).toEqual([]);
    expect(summary.samplePrompts).toEqual([]);
    expect(summary.decisionArtifact).toBeUndefined();
    expect(summary.regulatedDomain).toBeUndefined();
    expect(summary.expertCount).toBe(2);
  });
});

describe("groupByDiscipline", () => {
  it("exposes the five disciplines in a stable order", () => {
    expect(DISCIPLINES).toEqual([
      "Engineering",
      "Startup & Career",
      "Product & Design",
      "Go-to-market",
      "Finance, People, Legal & Exec",
    ]);
  });

  it("returns only non-empty groups in discipline order with panels sorted by name", () => {
    const summaries: readonly PanelSummary[] = [
      toPanelSummary("ux-review", rawPanel({ name: "ux-review", tags: ["design", "ux"] })),
      toPanelSummary("code-review", rawPanel({ name: "code-review" })),
      toPanelSummary("architecture-review", rawPanel({ name: "architecture-review" })),
    ];

    const groups = groupByDiscipline(summaries);

    expect(groups.map((group) => group.discipline)).toEqual(["Engineering", "Product & Design"]);
    expect(groups[0]?.panels.map((panel) => panel.name)).toEqual([
      "Architecture Review",
      "Code Review",
    ]);
    expect(groups[1]?.panels.map((panel) => panel.name)).toEqual(["UX Review"]);
  });
});
