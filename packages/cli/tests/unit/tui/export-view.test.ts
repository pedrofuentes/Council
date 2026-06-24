import { describe, expect, it, vi } from "vitest";

import type { Panel } from "../../../src/memory/repositories/panels.js";
import type { TranscriptDocument } from "../../../src/memory/transcript.js";
import {
  createExportSource,
  type ExportSourceDeps,
} from "../../../src/tui/adapters/export-view.js";

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

const createDeps = (
  overrides: Partial<ExportSourceDeps> = {},
): {
  readonly deps: ExportSourceDeps;
  readonly loadTranscript: ReturnType<typeof vi.fn>;
  readonly renderMarkdown: ReturnType<typeof vi.fn>;
  readonly renderJson: ReturnType<typeof vi.fn>;
  readonly renderAdr: ReturnType<typeof vi.fn>;
  readonly renderShare: ReturnType<typeof vi.fn>;
} => {
  const loadTranscript = vi.fn(async () => docFixture());
  const renderMarkdown = vi.fn(() => "MARKDOWN");
  const renderJson = vi.fn(() => "JSON");
  const renderAdr = vi.fn(() => "ADR");
  const renderShare = vi.fn(() => "SHARE");
  const deps: ExportSourceDeps = {
    loadTranscript,
    renderMarkdown,
    renderJson,
    renderAdr,
    renderShare,
    ...overrides,
  };
  return { deps, loadTranscript, renderMarkdown, renderJson, renderAdr, renderShare };
};

describe("createExportSource", () => {
  it("routes the markdown format to renderMarkdown only", async () => {
    const { deps, renderMarkdown, renderJson, renderAdr, renderShare } = createDeps();
    const source = createExportSource(deps);

    await expect(source.render("Acme", "markdown")).resolves.toBe("MARKDOWN");

    expect(renderMarkdown).toHaveBeenCalledOnce();
    expect(renderJson).not.toHaveBeenCalled();
    expect(renderAdr).not.toHaveBeenCalled();
    expect(renderShare).not.toHaveBeenCalled();
  });

  it("routes the json format to renderJson only", async () => {
    const { deps, renderMarkdown, renderJson, renderAdr, renderShare } = createDeps();
    const source = createExportSource(deps);

    await expect(source.render("Acme", "json")).resolves.toBe("JSON");

    expect(renderJson).toHaveBeenCalledOnce();
    expect(renderMarkdown).not.toHaveBeenCalled();
    expect(renderAdr).not.toHaveBeenCalled();
    expect(renderShare).not.toHaveBeenCalled();
  });

  it("routes the adr format to renderAdr only", async () => {
    const { deps, renderMarkdown, renderJson, renderAdr, renderShare } = createDeps();
    const source = createExportSource(deps);

    await expect(source.render("Acme", "adr")).resolves.toBe("ADR");

    expect(renderAdr).toHaveBeenCalledOnce();
    expect(renderMarkdown).not.toHaveBeenCalled();
    expect(renderJson).not.toHaveBeenCalled();
    expect(renderShare).not.toHaveBeenCalled();
  });

  it("routes the share format to renderShare only", async () => {
    const { deps, renderMarkdown, renderJson, renderAdr, renderShare } = createDeps();
    const source = createExportSource(deps);

    await expect(source.render("Acme", "share")).resolves.toBe("SHARE");

    expect(renderShare).toHaveBeenCalledOnce();
    expect(renderMarkdown).not.toHaveBeenCalled();
    expect(renderJson).not.toHaveBeenCalled();
    expect(renderAdr).not.toHaveBeenCalled();
  });

  it("passes the loaded transcript document to the selected renderer", async () => {
    const doc = docFixture();
    const { deps, renderMarkdown } = createDeps({ loadTranscript: vi.fn(async () => doc) });
    const source = createExportSource(deps);

    await source.render("Acme", "markdown");

    expect(renderMarkdown).toHaveBeenCalledWith(doc);
  });

  it("threads the panel name and debate id through to loadTranscript", async () => {
    const { deps, loadTranscript } = createDeps();
    const source = createExportSource(deps);

    await source.render("Acme", "markdown", "debate-7");

    expect(loadTranscript).toHaveBeenCalledWith("Acme", "debate-7");
  });

  it("returns null and renders nothing when the transcript is unavailable", async () => {
    const { deps, renderMarkdown, renderJson, renderAdr, renderShare } = createDeps({
      loadTranscript: vi.fn(async () => null),
    });
    const source = createExportSource(deps);

    // Null-branch bite: an unknown/empty transcript short-circuits before any
    // renderer runs, so the screen can show an honest "nothing to export" state
    // instead of throwing or writing an empty artifact.
    await expect(source.render("ghost", "markdown")).resolves.toBeNull();
    expect(renderMarkdown).not.toHaveBeenCalled();
    expect(renderJson).not.toHaveBeenCalled();
    expect(renderAdr).not.toHaveBeenCalled();
    expect(renderShare).not.toHaveBeenCalled();
  });

  it("sanitizes each preview line: strips ANSI/control sequences and collapses CR/LF/separators", async () => {
    const { deps } = createDeps({
      renderMarkdown: vi.fn(() => "# Title\u001b[2K\n> body\rSPOOF\u2028X\u0007 end"),
    });
    const source = createExportSource(deps);

    const preview = await source.render("Acme", "markdown");

    // toSingleLineDisplay (NOT stripControlChars) must run per line: ANSI/BEL are
    // stripped and the CR / U+2028 row-spoofing chars are collapsed to spaces.
    // If the sanitizer call is dropped, the raw payload survives and this fails.
    expect(preview).toBe("# Title\n> body SPOOF X end");
    expect(preview).not.toContain("\u001b");
    expect(preview).not.toContain("\u0007");
    expect(preview).not.toContain("\r");
    expect(preview).not.toContain("\u2028");
  });

  it("preserves the structural newlines between rendered lines", async () => {
    const { deps } = createDeps({
      renderMarkdown: vi.fn(() => "line1\nline2\nline3"),
    });
    const source = createExportSource(deps);

    const preview = await source.render("Acme", "markdown");

    // The sanitizer must sanitize PER LINE and rejoin with "\n" — collapsing the
    // whole document to a single line (a naive toSingleLineDisplay over the full
    // string) would destroy the transcript structure and fail this assertion.
    expect(preview).toBe("line1\nline2\nline3");
    expect((preview ?? "").split("\n")).toHaveLength(3);
  });
});
