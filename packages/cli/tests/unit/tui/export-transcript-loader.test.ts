import { describe, expect, it, vi } from "vitest";

import type { Panel } from "../../../src/memory/repositories/panels.js";
import type { TranscriptDocument } from "../../../src/memory/transcript.js";
import { createExportTranscriptLoader } from "../../../src/tui/index.js";

const panel: Panel = {
  id: "p1",
  name: "Acme",
  topic: "Launch timing",
  copilotHome: "/home/copilot",
  configJson: "{}",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const docFixture = (): TranscriptDocument => ({
  panel,
  experts: [],
  originalPrompt: "Should we launch?",
  latestDebate: {
    id: "d1",
    prompt: "Should we launch?",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-02T00:00:00.000Z",
  },
  turns: [],
});

/**
 * Finding 2 (Sentinel #1694): the export wiring used to wrap the raw transcript
 * loader in `try { … } catch { return null }`, which converted EVERY failure —
 * including unexpected ones like a missing / corrupt DB or a query bug — into a
 * `null` result the overlay renders as the honest "No transcript" empty state.
 * The masked failures were indistinguishable from a genuinely-absent transcript.
 *
 * `createExportTranscriptLoader` must instead surface unexpected failures by
 * letting the rejection propagate (the overlay's `.catch` renders a real error
 * state), while still mapping a genuinely-absent transcript (`null`) to the
 * empty state.
 */
describe("createExportTranscriptLoader — export transcript load (Sentinel #1694 §2)", () => {
  it("propagates an UNEXPECTED load failure instead of masking it as an empty transcript", async () => {
    const load = vi.fn(async (): Promise<TranscriptDocument | null> => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    });
    const loader = createExportTranscriptLoader(load);

    // Discriminating oracle: the real error text must reach the caller (→ the
    // overlay surfaces it), NOT be swallowed into a resolved `null`.
    await expect(loader("Acme")).rejects.toThrow(
      "SQLITE_CORRUPT: database disk image is malformed",
    );
    expect(load).toHaveBeenCalledWith("Acme", undefined);
  });

  it("returns null for a genuinely-absent transcript so the overlay keeps the honest empty state", async () => {
    const load = vi.fn(async (): Promise<TranscriptDocument | null> => null);
    const loader = createExportTranscriptLoader(load);

    // Inverse: an absent transcript must NOT become a false error.
    await expect(loader("ghost")).resolves.toBeNull();
  });

  it("passes a loaded transcript through unchanged and threads panelName + debateId", async () => {
    const doc = docFixture();
    const load = vi.fn(async (): Promise<TranscriptDocument | null> => doc);
    const loader = createExportTranscriptLoader(load);

    await expect(loader("Acme", "debate-7")).resolves.toBe(doc);
    expect(load).toHaveBeenCalledWith("Acme", "debate-7");
  });

  it("normalizes an undefined-returning loader to null (absent, not error)", async () => {
    const load = vi.fn(
      async (): Promise<TranscriptDocument | null> =>
        undefined as unknown as TranscriptDocument | null,
    );
    const loader = createExportTranscriptLoader(load);

    await expect(loader("ghost")).resolves.toBeNull();
  });
});
