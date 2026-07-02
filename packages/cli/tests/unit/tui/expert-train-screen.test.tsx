import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ExpertTrainingDataSource } from "../../../src/tui/adapters/expert-training.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import type { PathCompletion } from "../../../src/tui/lib/path-complete.js";
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

function renderScreenWithComplete(
  fakeCompletePath: (input: string) => Promise<PathCompletion>,
  training?: ExpertTrainingDataSource,
): ReturnType<typeof render> {
  return render(
    <DataProvider value={withTraining(training)}>
      <InputCaptureProvider>
        <MemoryRouter initialEntries={["/experts/cto/train"]}>
          <Routes>
            <Route
              path="/experts/:slug/train"
              element={
                <ExpertTrainScreen theme={theme} isActive completePath={fakeCompletePath} />
              }
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

describe("ExpertTrainScreen — completion guards", () => {
  it("does not produce an unhandled rejection when completer rejects", async () => {
    const unhandledErrors: unknown[] = [];
    const onUnhandledRejection = (err: unknown): void => {
      unhandledErrors.push(err);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const fakeComplete = vi
        .fn<(input: string) => Promise<PathCompletion>>()
        .mockRejectedValue(new Error("fs error"));
      const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

      stdin.write("\t");
      await flush();

      expect(unhandledErrors).toHaveLength(0);
      expect(lastFrame()).toContain("Document file path:");
      unmount();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("does not mutate state after the screen unmounts (unmount guard)", async () => {
    let resolveDeferred!: (val: PathCompletion) => void;
    const deferred = new Promise<PathCompletion>((res) => {
      resolveDeferred = res;
    });
    const fakeComplete = vi
      .fn<(input: string) => Promise<PathCompletion>>()
      .mockReturnValue(deferred);

    const { stdin, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write("\t");
    await flush();

    // Unmount before the completion resolves.
    unmount();
    await flush();

    // Use a getter trap: with no guard the .then() handler accesses
    // completion.completed; with the unmount guard it returns early before
    // reaching that line, so the getter is never invoked.
    let completedWasAccessed = false;
    const completionTrap: PathCompletion = {
      get completed(): string {
        completedWasAccessed = true;
        return "./post-unmount.md";
      },
      candidates: [],
    };

    resolveDeferred(completionTrap);
    await flush();

    expect(completedWasAccessed).toBe(false);
  });

  it("discards a stale completion when the user edits the input after pressing Tab", async () => {
    let resolveDeferred!: (val: PathCompletion) => void;
    const deferred = new Promise<PathCompletion>((res) => {
      resolveDeferred = res;
    });
    const fakeComplete = vi
      .fn<(input: string) => Promise<PathCompletion>>()
      .mockReturnValue(deferred);

    const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write("./docs/str");
    await flush();
    stdin.write("\t"); // Tab: starts the deferred completion
    await flush();

    // User edits the input before the completion resolves.
    stdin.write("ing");
    await flush();

    // Resolve the deferred with a result that should now be stale.
    resolveDeferred({ completed: "./docs/stale-result.md", candidates: ["./docs/stale-result.md"] });
    await flush();

    // The user's edited value must win; the stale completion must be discarded.
    expect(lastFrame()).toContain("./docs/string");
    expect(lastFrame()).not.toContain("./docs/stale-result.md");
    unmount();
  });

  it("uses the latest Tab result and discards stale earlier completions", async () => {
    let resolveFirst!: (val: PathCompletion) => void;
    let resolveSecond!: (val: PathCompletion) => void;
    const first = new Promise<PathCompletion>((res) => {
      resolveFirst = res;
    });
    const second = new Promise<PathCompletion>((res) => {
      resolveSecond = res;
    });

    let callCount = 0;
    const fakeComplete = vi
      .fn<(input: string) => Promise<PathCompletion>>()
      .mockImplementation(() => {
        callCount += 1;
        return callCount === 1 ? first : second;
      });

    const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write("./");
    await flush();
    stdin.write("\t"); // first Tab → deferred `first`
    await flush();
    stdin.write("\t"); // second Tab → deferred `second`
    await flush();

    // Resolve the SECOND (latest) request first.
    resolveSecond({ completed: "./second-result.md", candidates: ["./second-result.md"] });
    await flush();

    // Resolve the FIRST (stale) request last — must be discarded.
    resolveFirst({ completed: "./first-result.md", candidates: ["./first-result.md"] });
    await flush();

    expect(lastFrame()).toContain("./second-result.md");
    expect(lastFrame()).not.toContain("./first-result.md");
    unmount();
  });
});

describe("ExpertTrainScreen — Tab completion and hint", () => {
  it("renders the example hint line", () => {
    const { lastFrame, unmount } = renderScreen();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tab complete");
    expect(frame).toContain("Enter train");
    unmount();
  });

  it("Tab applies completion to the input", async () => {
    const fakeComplete = vi.fn<(input: string) => Promise<PathCompletion>>().mockResolvedValue({
      completed: "./docs/strategy.md",
      candidates: ["./docs/strategy.md"],
    });

    const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write("./docs/str");
    await flush();
    stdin.write("\t");
    await flush();

    expect(fakeComplete).toHaveBeenCalledWith("./docs/str");
    expect(lastFrame()).toContain("./docs/strategy.md");
    unmount();
  });

  it("Tab renders completion candidates", async () => {
    const fakeComplete = vi.fn<(input: string) => Promise<PathCompletion>>().mockResolvedValue({
      completed: "./ba",
      candidates: ["./bar.md", "./baz.md"],
    });

    const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write("b");
    await flush();
    stdin.write("\t");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("./bar.md");
    expect(frame).toContain("./baz.md");
    unmount();
  });

  it("clears stale candidates when the user manually edits the input after Tab", async () => {
    const fakeComplete = vi.fn<(input: string) => Promise<PathCompletion>>().mockResolvedValue({
      completed: "./ba",
      candidates: ["./bar.md", "./baz.md"],
    });

    const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write("b");
    await flush();
    stdin.write("\t");
    await flush();

    // Non-vacuous: the candidates for the OLD input must be rendered first.
    expect(lastFrame()).toContain("./bar.md");
    expect(lastFrame()).toContain("./baz.md");

    // The user manually edits the input, superseding the previous completion.
    stdin.write("x");
    await flush();

    // The stale suggestions for the OLD input must disappear immediately,
    // independent of any new fetch.
    expect(lastFrame()).not.toContain("./bar.md");
    expect(lastFrame()).not.toContain("./baz.md");
    unmount();
  });

  it("still surfaces new candidates for the edited input after clearing stale ones", async () => {
    const fakeComplete = vi
      .fn<(input: string) => Promise<PathCompletion>>()
      .mockResolvedValueOnce({ completed: "./ba", candidates: ["./bar.md", "./baz.md"] })
      .mockResolvedValueOnce({ completed: "./qux", candidates: ["./quux.md"] });

    const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write("b");
    await flush();
    stdin.write("\t");
    await flush();
    expect(lastFrame()).toContain("./bar.md");

    // Manual edit clears the stale candidates.
    stdin.write("q");
    await flush();
    expect(lastFrame()).not.toContain("./bar.md");

    // A subsequent completion for the NEW input still surfaces fresh candidates.
    stdin.write("\t");
    await flush();
    expect(lastFrame()).toContain("./quux.md");
    expect(lastFrame()).not.toContain("./bar.md");
    unmount();
  });

  it("Tab sanitizes candidates before rendering", async () => {
    const fakeComplete = vi.fn<(input: string) => Promise<PathCompletion>>().mockResolvedValue({
      completed: "./",
      candidates: ["./evil\x1b[31mfile.md", "./ok.md"],
    });

    const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write(".");
    await flush();
    stdin.write("\t");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\x1b[31m");
    expect(frame).toContain("./evilfile.md");
    expect(frame).toContain("./ok.md");
    unmount();
  });

  it("Tab with no match leaves input unchanged and renders no candidates", async () => {
    const fakeComplete = vi.fn<(input: string) => Promise<PathCompletion>>().mockResolvedValue({
      completed: "zzz",
      candidates: [],
    });

    const { stdin, lastFrame, unmount } = renderScreenWithComplete(fakeComplete);

    stdin.write("zzz");
    await flush();
    stdin.write("\t");
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("zzz");
    unmount();
  });
});

describe("ExpertTrainScreen — stop warning", () => {
  const doneResult = (
    stopWarning?: string,
  ): Awaited<ReturnType<ExpertTrainingDataSource["train"]>> => ({
    filesProcessed: 1,
    filesFailed: 0,
    filesSkipped: 0,
    filesNeedingReview: 0,
    totalWords: 42,
    profileUpdated: true,
    profileError: null,
    ...(stopWarning === undefined ? {} : { stopWarning }),
  });

  // Isolate the warning line from the rest of the frame: the ⚠ glyph is used
  // only by the stop-warning element, so it uniquely identifies that line.
  const warningLine = (frame: string | undefined): string | undefined =>
    (frame ?? "").split("\n").find((line) => line.includes("⚠"));

  it("renders the adapter stop warning distinctly from the success status", async () => {
    const { stdin, lastFrame, unmount } = renderScreen({
      train: async () => doneResult("Engine shutdown failed: lingering subprocess"),
    });

    stdin.write("/docs/notes.md");
    await flush();
    stdin.write("\r");
    await flush();

    // The normal success status is still shown …
    expect(lastFrame()).toContain("✓ Persona profile updated.");
    // … and the teardown warning appears as an additional, distinct line.
    const line = warningLine(lastFrame());
    expect(line).toBeDefined();
    expect(line).toContain("Engine shutdown failed: lingering subprocess");
    unmount();
  });

  it("sanitizes an adversarial stop warning to a single control-char-free line", async () => {
    // TAB, C0, ANSI CSI, DEL, C1, bidi override/isolate, CR/LF and the Unicode
    // line/paragraph separators are all embedded; every one must be neutralized.
    const adversarial =
      "Engine shutdown failed:\u0009\u0000\u0008\u001b[31m\u007f\u009b\u202e\u2066\r\n\u2028\u2029lingering subprocess";
    const { stdin, lastFrame, unmount } = renderScreen({
      train: async () => doneResult(adversarial),
    });

    stdin.write("/docs/notes.md");
    await flush();
    stdin.write("\r");
    await flush();

    const frame = lastFrame() ?? "";
    // Single-line: the warning did not break across rows — exactly one marker.
    expect(frame.split("⚠").length - 1).toBe(1);
    const line = warningLine(frame);
    expect(line).toBeDefined();
    // No control, C1, bidi, or line/paragraph-separator bytes survive.
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    // The visible text is preserved and collapsed onto a single line.
    expect(line).toContain("Engine shutdown failed: lingering subprocess");
    unmount();
  });

  it("renders no warning element when the adapter reports no stop warning", async () => {
    const { stdin, lastFrame, unmount } = renderScreen({
      train: async () => doneResult(undefined),
    });

    stdin.write("/docs/notes.md");
    await flush();
    stdin.write("\r");
    await flush();

    // Non-vacuous: we reached the done state …
    expect(lastFrame()).toContain("Processed 1 document(s)");
    // … but no warning marker is rendered.
    expect(lastFrame()).not.toContain("⚠");
    unmount();
  });
});
