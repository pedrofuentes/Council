import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type {
  BuildResult,
  ExpertAuthoringSource,
  ExpertFormValues,
} from "../../../src/tui/adapters/expert-authoring.js";
import { DataProvider, type TuiDataSources } from "../../../src/tui/components/DataProvider.js";
import { InputCaptureProvider } from "../../../src/tui/components/InputCaptureProvider.js";
import { ExpertFormScreen } from "../../../src/tui/screens/ExpertFormScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const waitForEscape = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 140));
  await flush();
};

const definitionFor = (values: ExpertFormValues): ExpertDefinition => ({
  slug: values.slug.trim(),
  displayName: values.displayName.trim(),
  role: values.role.trim(),
  expertise: {
    weightedEvidence: values.weightedEvidence
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    referenceCases: [],
    notExpertIn: [],
  },
  epistemicStance: values.epistemicStance.trim(),
  kind: values.kind,
});

const createSource = (
  create: ExpertAuthoringSource["create"],
): {
  readonly source: ExpertAuthoringSource;
  readonly create: ExpertAuthoringSource["create"];
} => ({
  create,
  source: {
    loadForEdit: async () => undefined,
    create,
    update: async (_slug, values) => ({ ok: true, definition: definitionFor(values) }),
    remove: async () => ({ affectedPanels: [] }),
    affectedPanels: async () => [],
  },
});

const withAuthoring = (source: ExpertAuthoringSource): TuiDataSources => ({
  panels: { loadList: async () => [], loadDetail: async () => undefined },
  expertAuthoring: source,
});

function SlugProbe(): React.ReactElement {
  const params = useParams();
  return <Text>DETAIL {params.slug}</Text>;
}

const loadedCtoForm = (): ExpertFormValues => ({
  slug: "cto",
  displayName: "Chief Technology Officer",
  role: "Technology strategy",
  weightedEvidence: "architecture reviews",
  referenceCases: "platform scaling",
  notExpertIn: "tax law",
  epistemicStance: "evidence first",
  kind: "generic",
  personaDescription: "",
  model: "gpt-4o",
});

function renderForm(source: ExpertAuthoringSource): ReturnType<typeof render> {
  return render(
    <InputCaptureProvider>
      <DataProvider value={withAuthoring(source)}>
        <MemoryRouter initialEntries={["/", "/experts/new"]} initialIndex={1}>
          <Routes>
            <Route path="/" element={<Text>PARENT</Text>} />
            <Route path="/experts/new" element={<ExpertFormScreen theme={theme} />} />
            <Route path="/experts/:slug" element={<SlugProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

function renderEditForm(source: ExpertAuthoringSource): ReturnType<typeof render> {
  return render(
    <InputCaptureProvider>
      <DataProvider value={withAuthoring(source)}>
        <MemoryRouter initialEntries={["/experts/cto/edit"]}>
          <Routes>
            <Route
              path="/experts/:slug/edit"
              element={<ExpertFormScreen formMode="edit" theme={theme} />}
            />
            <Route path="/experts/:slug" element={<SlugProbe />} />
          </Routes>
        </MemoryRouter>
      </DataProvider>
    </InputCaptureProvider>,
  );
}

const highlightedRow = (frame: string): string | undefined =>
  frame
    .split("\n")
    .find((line) => line.includes("\u001B[7m"))
    ?.replace(ansiPattern, "");

describe("ExpertFormScreen", () => {
  it("renders sanitized create fields and hides persona description for generic experts", async () => {
    const { source } = createSource(async (values) => ({
      ok: true,
      definition: definitionFor(values),
    }));
    const { lastFrame, unmount } = renderForm(source);

    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Slug:");
    expect(frame).toContain("Display name:");
    expect(frame).toContain("Role:");
    expect(frame).toContain("Weighted evidence:");
    expect(frame).toContain("Reference cases:");
    expect(frame).toContain("Not expert in:");
    expect(frame).toContain("Epistemic stance:");
    expect(frame).toContain("Kind: generic");
    expect(frame).toContain("Model:");
    expect(frame).not.toContain("Persona description:");
    expect(frame).toContain("↑↓ move · Enter edit · Ctrl+S save · Esc back");
    expect(highlightedRow(frame)).toContain("Slug:");
    unmount();
  });

  it("edits text fields, moves with every navigation key, and ignores printable no-ops in nav mode", async () => {
    const { source } = createSource(async (values) => ({
      ok: true,
      definition: definitionFor(values),
    }));
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    stdin.write("x");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Slug:");

    stdin.write("\r");
    await flush();
    stdin.write("alpha");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("*Slug: alpha");

    stdin.write("\u001B[B");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Display name:");
    stdin.write("j");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Role:");
    stdin.write("\t");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Weighted evidence:");
    stdin.write("\u001B[A");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Role:");
    stdin.write("k");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Display name:");
    stdin.write("\u001B[Z");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Slug:");
    unmount();
  });

  it("cancels text editing with Escape and ignores Ctrl+S while editing", async () => {
    const create = vi.fn<
      Parameters<ExpertAuthoringSource["create"]>,
      ReturnType<ExpertAuthoringSource["create"]>
    >(async (values) => ({ ok: true, definition: definitionFor(values) }));
    const { source } = createSource(create);
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    stdin.write("\r");
    await flush();
    stdin.write("draft");
    await flush();
    stdin.write("\u0013");
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect((lastFrame() ?? "").replace(ansiPattern, "")).toContain("Slug: draft");

    stdin.write("\u001B");
    await waitForEscape();
    expect(lastFrame()).toContain("Slug:");
    expect(lastFrame()).not.toContain("draft");
    unmount();
  });

  it("cycles kind from generic to persona, reveals persona description, and supports left/right enum editing", async () => {
    const { source } = createSource(async (values) => ({
      ok: true,
      definition: definitionFor(values),
    }));
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    for (let i = 0; i < 7; i += 1) {
      stdin.write("\u001B[B");
      await flush();
    }
    expect(highlightedRow(lastFrame() ?? "")).toContain("Kind: generic");

    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("Kind: persona");
    expect(lastFrame()).toContain("Persona description:");

    stdin.write("\r");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("\u001B[D");
    await flush();
    expect(lastFrame()).toContain("Kind: generic");
    expect(lastFrame()).not.toContain("Persona description:");
    stdin.write("\r");
    await flush();
    stdin.write("\u001B[C");
    await flush();
    expect(lastFrame()).toContain("Kind: persona");
    stdin.write("\u001B");
    await waitForEscape();
    expect(lastFrame()).toContain("Kind: generic");
    unmount();
  });

  it("shows adapter field errors on Ctrl+S, sanitizes them, moves to the first error, and does not navigate", async () => {
    const result: BuildResult = {
      ok: false,
      errors: [{ field: "slug", error: "Lowercase\n\u001B[31monly" }],
    };
    const create = vi.fn<
      Parameters<ExpertAuthoringSource["create"]>,
      ReturnType<ExpertAuthoringSource["create"]>
    >(async () => result);
    const { source } = createSource(create);
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    stdin.write("\u0013");
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("Lowercase only");
    expect(lastFrame()).not.toContain("\u001B[31m");
    expect(lastFrame()).not.toContain("DETAIL");
    expect(highlightedRow(lastFrame() ?? "")).toContain("Slug:");
    unmount();
  });

  it("saves valid values through create once and navigates to the encoded slug detail", async () => {
    const create = vi.fn<
      Parameters<ExpertAuthoringSource["create"]>,
      ReturnType<ExpertAuthoringSource["create"]>
    >(async (values) => ({ ok: true, definition: definitionFor(values) }));
    const { source } = createSource(create);
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    for (const value of ["alpha", "Alpha", "advisor", "reports", "cases", "none", "skeptical"]) {
      stdin.write("\r");
      await flush();
      stdin.write(value);
      await flush();
      stdin.write("\r");
      await flush();
      stdin.write("\u001B[B");
      await flush();
    }

    stdin.write("\u0013");
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "alpha",
        displayName: "Alpha",
        role: "advisor",
        weightedEvidence: "reports",
        referenceCases: "cases",
        notExpertIn: "none",
        epistemicStance: "skeptical",
        kind: "generic",
      }),
    );
    expect(lastFrame()).toContain("DETAIL alpha");
    unmount();
  });

  it("loads an expert for editing, keeps the slug read-only, updates values, and returns to detail", async () => {
    const update = vi.fn<
      Parameters<ExpertAuthoringSource["update"]>,
      ReturnType<ExpertAuthoringSource["update"]>
    >(async (_slug, values) => ({ ok: true, definition: definitionFor(values) }));
    const source: ExpertAuthoringSource = {
      loadForEdit: async () => loadedCtoForm(),
      create: async (values) => ({ ok: true, definition: definitionFor(values) }),
      update,
      remove: async () => ({ affectedPanels: [] }),
      affectedPanels: async () => [],
    };
    const { stdin, lastFrame, unmount } = renderEditForm(source);
    await flush();

    expect(lastFrame()).toContain("Display name: Chief Technology Officer");
    expect(highlightedRow(lastFrame() ?? "")).toContain("Slug: cto");

    stdin.write("\r");
    await flush();
    stdin.write("mutated");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("Slug: cto");
    expect(lastFrame()).not.toContain("Slug: ctomutated");

    stdin.write("\u001B[B");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write(" / Platform");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("\u0013");
    await flush();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      "cto",
      expect.objectContaining({
        slug: "cto",
        displayName: "Chief Technology Officer / Platform",
      }),
    );
    expect(lastFrame()).toContain("DETAIL cto");
    unmount();
  });

  it("renders an edit not found state when the expert cannot be loaded", async () => {
    const source: ExpertAuthoringSource = {
      loadForEdit: async () => undefined,
      create: async (values) => ({ ok: true, definition: definitionFor(values) }),
      update: async (_slug, values) => ({ ok: true, definition: definitionFor(values) }),
      remove: async () => ({ affectedPanels: [] }),
      affectedPanels: async () => [],
    };
    const { lastFrame, unmount } = renderEditForm(source);
    await flush();

    expect(lastFrame()).toMatch(/not found/i);
    unmount();
  });

  it("navigates back on Escape in nav mode", async () => {
    const { source } = createSource(async (values) => ({
      ok: true,
      definition: definitionFor(values),
    }));
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    stdin.write("\u001B");
    await waitForEscape();

    expect(lastFrame()).toContain("PARENT");
    unmount();
  });
});
