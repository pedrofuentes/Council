/**
 * Unit tests for the persisted-conclusion store (T-15b / F-02).
 *
 * The store reads/writes auto-generated Decision Framework conclusions in
 * a panel's `config_json` blob, keyed by debate id, so `council export`
 * can surface them. No new table / migration is involved.
 *
 * RED at this commit: src/cli/conclusion-store.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConcludeOutput } from "../../../src/cli/conclusion-synthesis.js";
import {
  persistConclusion,
  readStoredConclusions,
  selectStoredConclusion,
  upsertConclusionInConfig,
} from "../../../src/cli/conclusion-store.js";
import { createDatabase } from "../../../src/memory/db.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";

function makeOutput(overrides: Partial<ConcludeOutput> = {}): ConcludeOutput {
  return {
    panelName: "panel-a",
    topic: "Ship the MVP?",
    debateId: "debate-1",
    startedAt: "2024-01-01T00:00:00.000Z",
    consensus: ["Everyone agrees the coupling is painful"],
    tensions: ["Timeline is contested"],
    decisionMatrix: [{ dimension: "Risk", positions: [{ expert: "CTO", stance: "High" }] }],
    recommendation: "Begin a phased migration behind a feature flag.",
    confidence: "medium",
    ...overrides,
  };
}

describe("upsertConclusionInConfig", () => {
  it("adds conclusions keyed by debate id while preserving existing config keys", () => {
    const base = JSON.stringify({ template: "code-review", mode: "freeform", maxRounds: 3 });
    const updated = upsertConclusionInConfig(base, makeOutput(), "2024-02-02T00:00:00.000Z");
    const parsed = JSON.parse(updated) as Record<string, unknown>;

    expect(parsed["template"]).toBe("code-review");
    expect(parsed["mode"]).toBe("freeform");
    expect(parsed["maxRounds"]).toBe(3);

    const conclusions = parsed["conclusions"] as Record<string, { output: ConcludeOutput }>;
    expect(Object.keys(conclusions)).toEqual(["debate-1"]);
    expect(conclusions["debate-1"]?.output.recommendation).toBe(
      "Begin a phased migration behind a feature flag.",
    );
  });

  it("overwrites the same debate id instead of duplicating it", () => {
    const first = upsertConclusionInConfig(
      JSON.stringify({ template: "t" }),
      makeOutput({ recommendation: "First take" }),
      "2024-02-02T00:00:00.000Z",
    );
    const second = upsertConclusionInConfig(
      first,
      makeOutput({ recommendation: "Revised take" }),
      "2024-03-03T00:00:00.000Z",
    );
    const parsed = JSON.parse(second) as {
      conclusions: Record<string, { generatedAt: string; output: ConcludeOutput }>;
    };
    expect(Object.keys(parsed.conclusions)).toEqual(["debate-1"]);
    expect(parsed.conclusions["debate-1"]?.output.recommendation).toBe("Revised take");
    expect(parsed.conclusions["debate-1"]?.generatedAt).toBe("2024-03-03T00:00:00.000Z");
  });

  it("keeps multiple distinct debate ids side by side", () => {
    const first = upsertConclusionInConfig(
      "{}",
      makeOutput({ debateId: "debate-1" }),
      "2024-02-02T00:00:00.000Z",
    );
    const second = upsertConclusionInConfig(
      first,
      makeOutput({ debateId: "debate-2" }),
      "2024-03-03T00:00:00.000Z",
    );
    const parsed = JSON.parse(second) as { conclusions: Record<string, unknown> };
    expect(Object.keys(parsed.conclusions).sort()).toEqual(["debate-1", "debate-2"]);
  });

  it("does not throw on malformed config json (starts fresh)", () => {
    const updated = upsertConclusionInConfig("not-json{", makeOutput(), "2024-02-02T00:00:00.000Z");
    const parsed = JSON.parse(updated) as { conclusions: Record<string, unknown> };
    expect(Object.keys(parsed.conclusions)).toEqual(["debate-1"]);
  });
});

describe("readStoredConclusions", () => {
  it("returns an empty array when no conclusions are stored (legacy panels)", () => {
    expect(readStoredConclusions(JSON.stringify({ template: "code-review" }))).toEqual([]);
  });

  it("returns an empty array for malformed config json", () => {
    expect(readStoredConclusions("not-json{")).toEqual([]);
  });

  it("parses valid stored conclusions and drops malformed entries", () => {
    const good = upsertConclusionInConfig("{}", makeOutput(), "2024-02-02T00:00:00.000Z");
    const withJunk = JSON.parse(good) as { conclusions: Record<string, unknown> };
    withJunk.conclusions["debate-junk"] = { version: 1, generatedAt: "x", output: { nope: true } };
    const parsed = readStoredConclusions(JSON.stringify(withJunk));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.output.debateId).toBe("debate-1");
  });
});

describe("selectStoredConclusion", () => {
  it("returns undefined when nothing is stored", () => {
    expect(selectStoredConclusion(JSON.stringify({ template: "t" }))).toBeUndefined();
  });

  it("prefers an exact debate-id match over the newest", () => {
    const one = upsertConclusionInConfig(
      "{}",
      makeOutput({ debateId: "debate-1", recommendation: "Old but matching" }),
      "2024-01-01T00:00:00.000Z",
    );
    const two = upsertConclusionInConfig(
      one,
      makeOutput({ debateId: "debate-2", recommendation: "Newest but not matching" }),
      "2024-09-09T00:00:00.000Z",
    );
    const selected = selectStoredConclusion(two, "debate-1");
    expect(selected?.output.debateId).toBe("debate-1");
    expect(selected?.output.recommendation).toBe("Old but matching");
  });

  it("falls back to the newest by generatedAt when no debate id matches", () => {
    const one = upsertConclusionInConfig(
      "{}",
      makeOutput({ debateId: "debate-1", recommendation: "Older" }),
      "2024-01-01T00:00:00.000Z",
    );
    const two = upsertConclusionInConfig(
      one,
      makeOutput({ debateId: "debate-2", recommendation: "Newer" }),
      "2024-09-09T00:00:00.000Z",
    );
    const selected = selectStoredConclusion(two, "no-such-debate");
    expect(selected?.output.recommendation).toBe("Newer");
  });
});

describe("persistConclusion", () => {
  let testHome: string;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-store-test-"));
  });

  afterEach(async () => {
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("writes the conclusion into the panel's config_json, keyed by debate id", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panelRepo = new PanelRepository(db);
      const panel = await panelRepo.create({
        name: "persist-panel",
        topic: "T",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
      });

      await persistConclusion(db, panel.id, makeOutput({ debateId: "debate-xyz" }));

      const reloaded = await panelRepo.findById(panel.id);
      if (reloaded === undefined) throw new Error("panel was not reloaded");
      const stored = selectStoredConclusion(reloaded.configJson, "debate-xyz");
      expect(stored?.output.debateId).toBe("debate-xyz");
      expect(stored?.version).toBeGreaterThanOrEqual(1);
      // Existing config keys survive the write.
      const cfg = JSON.parse(reloaded.configJson) as Record<string, unknown>;
      expect(cfg["template"]).toBe("code-review");
    } finally {
      await db.destroy();
    }
  });

  it("overwrites the same debate id on a second persist", async () => {
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panelRepo = new PanelRepository(db);
      const panel = await panelRepo.create({
        name: "persist-overwrite",
        topic: "T",
        copilotHome: path.join(testHome, "copilot"),
        configJson: JSON.stringify({ template: "code-review" }),
      });

      await persistConclusion(db, panel.id, makeOutput({ recommendation: "First" }));
      await persistConclusion(db, panel.id, makeOutput({ recommendation: "Second" }));

      const reloaded = await panelRepo.findById(panel.id);
      if (reloaded === undefined) throw new Error("panel was not reloaded");
      const all = readStoredConclusions(reloaded.configJson);
      expect(all).toHaveLength(1);
      expect(all[0]?.output.recommendation).toBe("Second");
    } finally {
      await db.destroy();
    }
  });
});
