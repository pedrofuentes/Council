/**
 * T9 — convene must persist the FULL resolved panel definition into the
 * session's `config_json` so a session can later be promoted to a library
 * panel via `council panel save`. It must also reword the auto-compose
 * banner to make the run-scope explicit and surface the save hint.
 *
 * RED at this commit: convene stores only `{ template, mode, ... }` (no
 * `definition`) and the banner reads "Auto-composed panel: <name>".
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";

const validPanelJson = JSON.stringify({
  name: "auto-panel",
  description: "Auto-composed panel for the topic",
  experts: [
    {
      slug: "alpha",
      displayName: "Alpha (Skeptic)",
      role: "Skeptic",
      expertise: { weightedEvidence: ["counter-examples"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Alpha rejects claims without falsification tests.",
    },
    {
      slug: "beta",
      displayName: "Beta (Builder)",
      role: "Builder",
      expertise: { weightedEvidence: ["empirical wins"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Beta trusts what ships and runs in production.",
    },
    {
      slug: "gamma",
      displayName: "Gamma (User Voice)",
      role: "User advocate",
      expertise: { weightedEvidence: ["user studies"], referenceCases: [], notExpertIn: [] },
      epistemicStance: "Gamma weights observed user behavior over speculation.",
    },
  ],
});

/** Stub engine: first send returns the panel JSON; later sends return generic text. */
class ScriptedEngine implements CouncilEngine {
  readonly #experts = new Map<string, ExpertSpec>();
  readonly responses: string[];
  callIndex = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(spec: ExpertSpec): Promise<void> {
    this.#experts.set(spec.id, spec);
  }
  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
  }
  async listModels(): Promise<readonly string[]> {
    return ["stub"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    if (!this.#experts.has(options.expertId)) {
      throw new Error(`Expert ${options.expertId} is not registered`);
    }
    const text = this.responses[this.callIndex] ?? "[default reply]";
    this.callIndex += 1;
    const expertId = options.expertId;
    return (async function* (): AsyncGenerator<EngineEvent, void, void> {
      yield { kind: "message.delta", expertId, text };
      yield {
        kind: "message.complete",
        expertId,
        response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
      };
    })();
  }
}

interface StoredConfig {
  readonly template?: string;
  readonly mode?: string;
  readonly definition?: {
    readonly name: string;
    readonly experts: ReadonlyArray<{
      readonly slug: string;
      readonly role: string;
      readonly epistemicStance: string;
      readonly expertise: { readonly weightedEvidence: readonly string[] };
    }>;
  };
}

describe("convene — persists the resolved panel definition (T9)", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-convene-def-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("stores the full ResolvedPanelDefinition (slug/role/expertise/stance) in config_json", async () => {
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([validPanelJson]),
      write: () => undefined,
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt event sourcing?",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--yes",
    ]);

    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      const session = panels.find((p) => p.name.startsWith("auto-panel-"));
      expect(session).toBeDefined();

      const config = JSON.parse(session?.configJson ?? "{}") as StoredConfig;

      // Backward-compatible fields are preserved.
      expect(config.template).toBe("auto-panel");
      expect(config.mode).toBeDefined();

      // The full structured definition is now persisted.
      expect(config.definition).toBeDefined();
      expect(config.definition?.name).toBe("auto-panel");
      const experts = config.definition?.experts ?? [];
      expect(experts.map((e) => e.slug)).toEqual(["alpha", "beta", "gamma"]);

      const alpha = experts.find((e) => e.slug === "alpha");
      expect(alpha?.role).toBe("Skeptic");
      expect(alpha?.epistemicStance).toContain("Alpha");
      expect(alpha?.expertise.weightedEvidence).toContain("counter-examples");
    } finally {
      await db.destroy();
    }
  });

  it("rewords the auto-compose banner for run-scope and surfaces the save hint", async () => {
    let stderr = "";
    let stdout = "";
    const cmd = buildConveneCommand({
      engineFactory: () => new ScriptedEngine([validPanelJson]),
      write: (s) => {
        stdout += s;
      },
      writeError: (s) => {
        stderr += s;
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt event sourcing?",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--yes",
    ]);

    // Banner makes the run-scope explicit and still names the panel.
    expect(stderr).toMatch(/auto-composed/i);
    expect(stderr).toContain("auto-panel");
    expect(stderr).toMatch(/for this run/i);
    expect(stderr).toMatch(/not saved to your library/i);

    // A next-step hint points at the new save command, with the real
    // (timestamped) session name so it is copy-pasteable.
    const combined = stdout + stderr;
    expect(combined).toContain("council panel save");
    expect(combined).toMatch(/council panel save auto-panel-/);
  });
});
