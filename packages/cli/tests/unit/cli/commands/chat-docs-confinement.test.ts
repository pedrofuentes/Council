/**
 * Direct unit coverage for the generic-expert docs-warning confinement sink in
 * `cli/commands/chat/shared.ts` (Sentinel digest #2060, items 2 & 3).
 *
 * Two properties that the integration-level traversal suite
 * (`chat-panel-slug-traversal.test.ts`) cannot exercise are pinned here:
 *
 *  - Item 2 (Dim D): the defense-in-depth `startsWith` containment guard. Every
 *    slug reaching `warnIfGenericExpertHasUnindexedDocs` has already passed
 *    `SLUG_RE`, so the guard's escape branch is unreachable through that caller.
 *    `resolveConfinedDocsPath` is the extracted, directly-callable helper whose
 *    escape (null) branch is asserted with a crafted `dataHome`/slug pairing.
 *
 *  - Item 3 (Dim B): the silent early-returns. A persona expert, a shape-rejected
 *    slug, and an empty/absent docs folder each return WITHOUT emitting a system
 *    message (and without disclosing any path). A positive control proves the
 *    silence is conditional — a valid generic expert with docs still warns.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveConfinedDocsPath,
  warnIfGenericExpertHasUnindexedDocs,
} from "../../../../src/cli/commands/chat/shared.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import type { ChatRenderer } from "../../../../src/cli/renderers/chat-renderer.js";

interface RecordedSystem {
  readonly message: string;
  readonly level: "info" | "warn" | "error" | undefined;
}

/**
 * A `ChatRenderer` double whose only observable behavior is recording every
 * `showSystem` call. All other sinks are no-ops — this function surfaces
 * warnings exclusively through `showSystem`, so an empty record proves silence.
 */
function makeRecordingRenderer(): {
  readonly renderer: ChatRenderer;
  readonly systemCalls: readonly RecordedSystem[];
} {
  const systemCalls: RecordedSystem[] = [];
  const noop = (): void => {
    /* no-op sink */
  };
  const renderer: ChatRenderer = {
    showSessionStatus: noop,
    showPrompt: noop,
    showUserMessage: noop,
    showThinking: noop,
    startExpertResponse: noop,
    streamChunk: noop,
    endExpertResponse: noop,
    showSystem: (message: string, level?: "info" | "warn" | "error"): void => {
      systemCalls.push({ message, level });
    },
    showSeparator: noop,
  };
  return { renderer, systemCalls };
}

function genericExpert(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: "Adversary",
    role: "Attacker",
    model: "test-model",
    expertise: {
      weightedEvidence: ["nothing"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "adversarial",
    kind: "generic",
  };
}

function personaExpert(slug: string): ExpertDefinition {
  return { ...genericExpert(slug), kind: "persona" };
}

describe("resolveConfinedDocsPath — DiD docs-root containment (#2060 item 2, Dim D)", () => {
  const dataHome = path.resolve(os.tmpdir(), "council-confine-pure");
  const expertsRoot = path.join(dataHome, "experts");

  it("returns the per-expert docs path for a contained slug (allowed branch)", () => {
    const resolved = resolveConfinedDocsPath(dataHome, "good-generic");
    expect(resolved).toBe(path.join(expertsRoot, "good-generic", "docs"));
    // Sanity: the returned path really is under the experts root.
    expect(path.resolve(resolved ?? "").startsWith(expertsRoot + path.sep)).toBe(true);
  });

  it("returns null for a `..` slug that escapes the experts root (rejected branch)", () => {
    // `../SECRET` resolves to <dataHome>/SECRET/docs — outside experts/.
    expect(resolveConfinedDocsPath(dataHome, "../SECRET")).toBeNull();
  });

  it("returns null for a deep traversal slug that climbs above dataHome", () => {
    expect(resolveConfinedDocsPath(dataHome, "../../../../etc")).toBeNull();
  });

  it("returns null for a slug whose normalized path lands on the experts root itself", () => {
    // `..` collapses experts/<slug> back to experts, so docs would resolve to
    // <dataHome>/experts/docs — NOT under `<experts>/` + separator.
    expect(resolveConfinedDocsPath(dataHome, "..")).toBeNull();
  });
});

describe("warnIfGenericExpertHasUnindexedDocs — silent early-returns (#2060 item 3, Dim B)", () => {
  let dataHome: string;

  beforeEach(async () => {
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-confine-"));
  });

  afterEach(async () => {
    await fs
      .rm(dataHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      .catch(() => {
        /* best-effort cleanup */
      });
  });

  it("stays silent for a persona expert (personas index their own docs)", async () => {
    // Plant docs the sink would warn about IF it did not early-return on persona.
    const docsDir = path.join(dataHome, "experts", "persona-x", "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "memo.md"), "trained", "utf-8");

    const { renderer, systemCalls } = makeRecordingRenderer();
    await warnIfGenericExpertHasUnindexedDocs(personaExpert("persona-x"), dataHome, renderer);

    expect(systemCalls).toHaveLength(0);
  });

  it("silently skips a shape-rejected slug without disclosing any path", async () => {
    // Plant a file the `../SECRET` traversal would resolve to, so an unguarded
    // sink would readdir it and echo its path + count.
    const secretDocs = path.join(dataHome, "SECRET", "docs");
    await fs.mkdir(secretDocs, { recursive: true });
    await fs.writeFile(path.join(secretDocs, "leak.txt"), "top secret", "utf-8");

    const { renderer, systemCalls } = makeRecordingRenderer();
    await warnIfGenericExpertHasUnindexedDocs(genericExpert("../SECRET"), dataHome, renderer);

    // By-design silence (SLUG_RE reject) — nothing emitted, nothing disclosed.
    expect(systemCalls).toHaveLength(0);
  });

  it("stays silent for a valid generic slug whose docs folder is absent", async () => {
    const { renderer, systemCalls } = makeRecordingRenderer();
    await warnIfGenericExpertHasUnindexedDocs(genericExpert("empty-generic"), dataHome, renderer);

    expect(systemCalls).toHaveLength(0);
  });

  it("stays silent for a valid generic slug whose docs folder is empty", async () => {
    await fs.mkdir(path.join(dataHome, "experts", "empty-generic", "docs"), { recursive: true });

    const { renderer, systemCalls } = makeRecordingRenderer();
    await warnIfGenericExpertHasUnindexedDocs(genericExpert("empty-generic"), dataHome, renderer);

    expect(systemCalls).toHaveLength(0);
  });

  it("warns exactly once for a valid generic expert that has unindexed docs (positive control)", async () => {
    // Proves the silent-skip assertions above are not vacuous: the sink DOES
    // emit for a well-formed, docs-bearing generic expert.
    const docsDir = path.join(dataHome, "experts", "good-generic", "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "memo.md"), "# ignored by a generic expert", "utf-8");

    const { renderer, systemCalls } = makeRecordingRenderer();
    await warnIfGenericExpertHasUnindexedDocs(genericExpert("good-generic"), dataHome, renderer);

    expect(systemCalls).toHaveLength(1);
    expect(systemCalls[0]?.level).toBe("warn");
    expect(systemCalls[0]?.message).toMatch(/\(good-generic\) is a generic expert/);
    expect(systemCalls[0]?.message).toMatch(/are NOT indexed and will be ignored/);
  });
});
