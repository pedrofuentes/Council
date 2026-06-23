import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ExpertTrainingDataSource } from "../../../src/tui/adapters/expert-training.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { ExpertTrainScreen } from "../../../src/tui/screens/ExpertTrainScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const withTraining = (training?: ExpertTrainingDataSource): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  training,
});

function renderScreen(training?: ExpertTrainingDataSource): ReturnType<typeof render> {
  return render(
    <DataProvider value={withTraining(training)}>
      <InputCaptureProvider>
        <MemoryRouter initialEntries={["/experts/cto/train"]}>
          <Routes>
            <Route
              path="/experts/:slug/train"
              element={<ExpertTrainScreen theme={theme} isActive />}
            />
          </Routes>
        </MemoryRouter>
      </InputCaptureProvider>
    </DataProvider>,
  );
}

describe("ExpertTrainScreen", () => {
  it("renders the document path prompt", () => {
    const { lastFrame, unmount } = renderScreen({
      train: async () => ({
        filesProcessed: 0,
        filesFailed: 0,
        filesSkipped: 0,
        filesNeedingReview: 0,
        totalWords: 0,
        profileUpdated: false,
        profileError: null,
      }),
    });

    expect(lastFrame()).toContain("Document file path:");
    unmount();
  });

  it("submits a local file path and renders sanitized progress and completion", async () => {
    const train = vi.fn<ExpertTrainingDataSource["train"]>(
      async (
        _slug,
        _input,
        onProgress,
      ): Promise<Awaited<ReturnType<ExpertTrainingDataSource["train"]>>> => {
        onProgress?.({
          filename: "\u001b[31mnotes.md\nspoof",
          wordCount: 12,
          status: "success",
        });
        onProgress?.({ filename: "draft.md", wordCount: 0, status: "needs-review" });
        return {
          filesProcessed: 1,
          filesFailed: 0,
          filesSkipped: 0,
          filesNeedingReview: 1,
          totalWords: 12,
          profileUpdated: true,
          profileError: null,
        };
      },
    );
    const { stdin, lastFrame, unmount } = renderScreen({ train });

    stdin.write("/docs/notes.md");
    await flush();
    stdin.write("\r");
    await flush();

    expect(train).toHaveBeenCalledWith("cto", { files: ["/docs/notes.md"] }, expect.any(Function));
    expect(lastFrame()).toContain("notes.md spoof: 12 words");
    expect(lastFrame()).toContain("draft.md: needs review");
    expect(lastFrame()).toContain("Processed 1 document(s) (0 failed, 1 needs review, 12 words)");
    expect(lastFrame()).toContain("✓ Persona profile updated.");
    expect(lastFrame()).not.toContain("\u001b[31m");
    unmount();
  });

  it("renders a sanitized failed progress line and profile refresh error", async () => {
    const train: ExpertTrainingDataSource["train"] = async (_slug, _input, onProgress) => {
      onProgress?.({
        filename: "bad.md",
        wordCount: 0,
        status: "failed",
        error: "\u001b[31mparse\nfailed",
      });
      return {
        filesProcessed: 0,
        filesFailed: 1,
        filesSkipped: 0,
        filesNeedingReview: 0,
        totalWords: 0,
        profileUpdated: false,
        profileError: "\u001b[32mprofile\nfailed",
      };
    };
    const { stdin, lastFrame, unmount } = renderScreen({ train });

    stdin.write("/docs/bad.md");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("bad.md: failed (parse failed)");
    expect(lastFrame()).toContain("Profile refresh failed: profile failed");
    expect(lastFrame()).not.toContain("\u001b[31m");
    expect(lastFrame()).not.toContain("\u001b[32m");
    unmount();
  });

  it("shows a sanitized error when training rejects", async () => {
    const { stdin, lastFrame, unmount } = renderScreen({
      train: async () => {
        throw new Error("\u001b[31mboom\nlater");
      },
    });

    stdin.write("/docs/bad.md");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("Training failed: boom later");
    expect(lastFrame()).not.toContain("\u001b[31m");
    unmount();
  });

  it("does not submit twice while training is in progress", async () => {
    let release:
      | ((value: Awaited<ReturnType<ExpertTrainingDataSource["train"]>>) => void)
      | undefined;
    const train = vi.fn<ExpertTrainingDataSource["train"]>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { stdin, lastFrame, unmount } = renderScreen({ train });

    stdin.write("/docs/slow.md");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("\r");
    await flush();

    expect(train).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("Training persona…");
    release?.({
      filesProcessed: 1,
      filesFailed: 0,
      filesSkipped: 0,
      filesNeedingReview: 0,
      totalWords: 5,
      profileUpdated: false,
      profileError: null,
    });
    await flush();
    unmount();
  });

  it("does not submit an empty path", async () => {
    const train = vi.fn<ExpertTrainingDataSource["train"]>();
    const { stdin, lastFrame, unmount } = renderScreen({ train });

    stdin.write("\r");
    await flush();

    expect(train).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Document file path:");
    unmount();
  });

  it("shows a sanitized unavailable message when no training source is provided", async () => {
    const { stdin, lastFrame, unmount } = renderScreen(undefined);

    stdin.write("/docs/notes.md");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("Training failed: training unavailable");
    unmount();
  });
});
