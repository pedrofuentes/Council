/**
 * Tests for convene auto-conclude persistence failure isolation (issue #2410).
 *
 * Acceptance:
 *   - When conclusion synthesis succeeds but persistence fails, the user
 *     MUST see the synthesized conclusion (never lose paid API work).
 *   - Persistence errors are reported as storage/persistence failures, NOT
 *     as "conclusion generation failed" (accurate diagnostics).
 *   - Synthesis failures remain unchanged: the catch block correctly reports
 *     "generation failed" when synthesis itself throws.
 *
 * RED at this commit: persistConclusion runs in the same try block as
 * synthesis/render, so any persistence failure skips rendering entirely and
 * is misreported by the generic "generation failed" handler.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import * as conclusionStore from "../../../../src/cli/conclusion-store.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";
import type {
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";

describe("convene auto-conclude persistence failure isolation", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "council-convene-persist-fail-test-"),
    );
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    setQuiet(false);
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch {
      /* best effort */
    }
  });

  it("renders the conclusion when synthesis succeeds but persistence fails", async () => {
    // Stub persistConclusion to throw a storage error.
    const persistStub = vi
      .spyOn(conclusionStore, "persistConclusion")
      .mockRejectedValue(new Error("UNIQUE constraint failed: panels.id"));

    let stdoutCapture = "";
    let stderrCapture = "";

    const cmd = buildConveneCommand({
      engineFactory: () => new MockEngine(),
      write: (s) => {
        stdoutCapture += s;
      },
      writeError: (s) => {
        stderrCapture += s;
      },
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TypeScript?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--heuristic-memory",
    ]);

    // Persistence was attempted.
    expect(persistStub).toHaveBeenCalledOnce();

    // The synthesized conclusion MUST appear in stdout despite the persist failure.
    // MockEngine returns a Decision Framework with "Proceed with a phased approach".
    expect(stdoutCapture).toContain("Decision Framework");
    expect(stdoutCapture).toContain("Proceed with a phased approach");

    // The error message MUST NOT say "generation failed" (synthesis succeeded).
    expect(stderrCapture).not.toContain("conclusion generation failed");

    // The error message MUST report a persistence/storage issue (accurate diagnostic).
    expect(stderrCapture).toContain("persist");
    expect(stderrCapture).toContain("UNIQUE constraint failed");
  });

  it("reports 'generation failed' when synthesis itself throws (unchanged behavior)", async () => {
    // Simulate a synthesis failure by using a rejecting engine.
    class FailingSynthesisEngine extends MockEngine {
      readonly #synthesizerIds = new Set<string>();

      override async addExpert(spec: ExpertSpec): Promise<void> {
        await super.addExpert(spec);
        if (spec.slug === "synthesizer") {
          this.#synthesizerIds.add(spec.id);
        }
      }

      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        if (!this.#synthesizerIds.has(options.expertId)) {
          return super.send(options);
        }

        return (async function* (): AsyncGenerator<EngineEvent, void, void> {
          yield { kind: "message.delta", expertId: options.expertId, text: "not json" };
          yield {
            kind: "message.complete",
            expertId: options.expertId,
            response: { latencyMs: 0, tokensIn: 1, tokensOut: 1 },
          };
        })();
      }
    }

    let stderrCapture = "";

    const cmd = buildConveneCommand({
      engineFactory: () => new FailingSynthesisEngine(),
      write: () => undefined,
      writeError: (s) => {
        stderrCapture += s;
      },
    });
    cmd.exitOverride();

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we adopt TypeScript?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--engine",
      "mock",
      "--heuristic-memory",
    ]);

    // Synthesis failures MUST still report "conclusion generation failed".
    expect(stderrCapture).toContain("conclusion generation failed");
  });
});
