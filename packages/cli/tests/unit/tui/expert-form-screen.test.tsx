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
    expect(frame).toContain("Slug (required):");
    expect(frame).toContain("Display name (required):");
    expect(frame).toContain("Role (required):");
    expect(frame).toContain("Weighted evidence (required):");
    expect(frame).toContain("Reference cases:");
    expect(frame).toContain("Not expert in:");
    expect(frame).toContain("Epistemic stance (required):");
    expect(frame).toContain("Kind: generic");
    expect(frame).toContain("Model:");
    expect(frame).not.toContain("Persona description:");
    expect(frame).toContain("↑↓ move · Enter edit · Ctrl+S save · Esc back");
    expect(highlightedRow(frame)).toContain("Kind:");
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
    // "x" is a no-op on the Kind enum field — cursor stays at Kind (index 0)
    expect(highlightedRow(lastFrame() ?? "")).toContain("Kind:");

    // Navigate down to Slug (index 1), enter edit mode, type, commit
    stdin.write("\u001B[B");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Slug");

    stdin.write("\r");
    await flush();
    stdin.write("alpha");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("*Slug (required): alpha");

    stdin.write("\u001B[B");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Display name");
    stdin.write("j");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Role");
    stdin.write("\t");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Weighted evidence");
    stdin.write("\u001B[A");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Role");
    stdin.write("k");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Display name");
    stdin.write("\u001B[Z");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Slug");
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

    // Navigate from Kind (index 0) down to Slug (index 1) before editing
    stdin.write("\u001B[B");
    await flush();

    stdin.write("\r");
    await flush();
    stdin.write("draft");
    await flush();
    stdin.write("\u0013");
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect((lastFrame() ?? "").replace(ansiPattern, "")).toContain("Slug (required): draft");

    stdin.write("\u001B");
    await waitForEscape();
    expect(lastFrame()).toContain("Slug (required):");
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

    // Kind is now first (index 0) — no navigation needed
    expect(highlightedRow(lastFrame() ?? "")).toContain("Kind: generic");

    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("Kind: persona");
    expect(lastFrame()).toContain("Persona description:");
    expect(lastFrame()).not.toContain("Persona description (required):");

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
    expect(highlightedRow(lastFrame() ?? "")).toContain("Slug (required):");
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

    // Kind is at index 0 with default "generic" — navigate down to Slug (index 1) first
    stdin.write("\u001B[B");
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

    // Kind is first (index 0); loaded expert is "generic"
    expect(lastFrame()).toContain("Chief Technology Officer");
    expect(highlightedRow(lastFrame() ?? "")).toContain("Kind:");

    // Navigate to Slug (index 1) and attempt to edit — slug is read-only in edit mode
    stdin.write("\u001B[B");
    await flush();
    expect(highlightedRow(lastFrame() ?? "")).toContain("Slug");

    stdin.write("\r");
    await flush();
    stdin.write("mutated");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("Slug (required): cto");
    expect(lastFrame()).not.toContain("ctomutated");

    // Navigate to Display name (index 2) and edit it
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

  it("first rendered/selected field is Kind (kind-first ordering)", async () => {
    const { source } = createSource(async (values) => ({
      ok: true,
      definition: definitionFor(values),
    }));
    const { lastFrame, unmount } = renderForm(source);
    await flush();

    const frame = lastFrame() ?? "";
    // Kind must appear before Slug in the rendered output
    const kindIdx = frame.indexOf("Kind:");
    const slugIdx = frame.indexOf("Slug");
    expect(kindIdx).toBeGreaterThan(-1);
    expect(slugIdx).toBeGreaterThan(-1);
    expect(kindIdx).toBeLessThan(slugIdx);

    // Kind must be the initially highlighted (selected) field
    expect(highlightedRow(frame)).toContain("Kind:");
    unmount();
  });

  it("required fields show (required) marker, distinct from dirty * prefix", async () => {
    const { source } = createSource(async (values) => ({
      ok: true,
      definition: definitionFor(values),
    }));
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    const initialFrame = lastFrame() ?? "";
    // Unchanged required fields show the (required) marker
    expect(initialFrame).toContain("Slug (required):");
    expect(initialFrame).toContain("Display name (required):");
    expect(initialFrame).toContain("Role (required):");
    // No dirty * marker on unchanged fields
    expect(initialFrame).not.toContain("*Slug");
    expect(initialFrame).not.toContain("*Display name");

    // Navigate to Slug (down once from Kind at index 0), then edit it
    stdin.write("\u001B[B"); // down to Slug
    await flush();
    stdin.write("\r"); // enter edit mode
    await flush();
    stdin.write("alpha");
    await flush();
    stdin.write("\r"); // commit
    await flush();

    // After editing: dirty (*) prefix AND (required) suffix both present, clearly distinct
    expect(lastFrame()).toContain("*Slug (required): alpha");
    unmount();
  });

  it("personaDescription required marker shown only when kind is persona", async () => {
    const { source } = createSource(async (values) => ({
      ok: true,
      definition: definitionFor(values),
    }));
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    // Initially generic — personaDescription hidden entirely
    expect(lastFrame()).not.toContain("Persona description:");

    // With kind-first ordering, Kind is at index 0 — press Enter to cycle to persona
    stdin.write("\r");
    await flush();

    // personaDescription now visible — it is OPTIONAL, no (required) marker
    expect(lastFrame()).toContain("Kind: persona");
    expect(lastFrame()).toContain("Persona description:");
    expect(lastFrame()).not.toContain("Persona description (required):");

    // Cycle back to generic — personaDescription hidden again
    stdin.write("\r");
    await flush();
    expect(lastFrame()).not.toContain("Persona description:");
    unmount();
  });

  it("maps a create rejection to a sanitized form-level error and does not navigate (#1623)", async () => {
    const create = vi.fn<
      Parameters<ExpertAuthoringSource["create"]>,
      ReturnType<ExpertAuthoringSource["create"]>
    >(async () => {
      throw new Error("disk\n\u001B[31mfull");
    });
    const { source } = createSource(create);
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    stdin.write("\u0013");
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("disk full");
    expect(frame).not.toContain("\u001B[31m");
    expect(frame).not.toContain("DETAIL");
    unmount();
  });

  it("guards against concurrent Ctrl+S saves, creating once and navigating once (#1624)", async () => {
    let resolveCreate: ((value: BuildResult) => void) | undefined;
    const create = vi.fn<
      Parameters<ExpertAuthoringSource["create"]>,
      ReturnType<ExpertAuthoringSource["create"]>
    >(
      () =>
        new Promise<BuildResult>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { source } = createSource(create);
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    stdin.write("\u001B[B");
    await flush();
    stdin.write("\r");
    await flush();
    stdin.write("alpha");
    await flush();
    stdin.write("\r");
    await flush();

    stdin.write("\u0013");
    await flush();
    stdin.write("\u0013");
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate?.({ ok: true, definition: definitionFor(loadedCtoForm()) });
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("DETAIL alpha");
    unmount();
  });

  it("ignores Esc while a save is in flight, then resumes Esc navigation once it settles (#1655)", async () => {
    let resolveCreate: ((value: BuildResult) => void) | undefined;
    const create = vi.fn<
      Parameters<ExpertAuthoringSource["create"]>,
      ReturnType<ExpertAuthoringSource["create"]>
    >(
      () =>
        new Promise<BuildResult>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { source } = createSource(create);
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    // Kick off a save (Ctrl+S). The deferred create keeps savingRef in flight so
    // the mid-flight state can be asserted deterministically.
    stdin.write("\u0013");
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    // Save is pending: zero navigations so far — still on the form, not the
    // back-stack route ("PARENT" at "/").
    expect(lastFrame()).not.toContain("PARENT");
    expect(lastFrame()).toContain("Esc back");

    // BITING: Esc DURING the in-flight save must be ignored — it must NOT
    // navigate back (the exact race fixed for the panel forms in #1646).
    stdin.write("\u001B");
    await waitForEscape();
    expect(lastFrame()).not.toContain("PARENT");
    expect(lastFrame()).toContain("Esc back");

    // Settle the save with a rejection so the form stays mounted (no self
    // navigation) and the in-flight window closes.
    resolveCreate?.({ ok: false, errors: [{ field: "slug", error: "nope" }] });
    await flush();
    expect(lastFrame()).not.toContain("PARENT");
    expect(lastFrame()).toContain("Esc back");

    // INVERSE: once the save settles the guard releases — Esc navigates again,
    // proving the guard is scoped strictly to the in-flight window.
    stdin.write("\u001B");
    await waitForEscape();
    expect(lastFrame()).toContain("PARENT");
    unmount();
  });

  it("shows an error state with Esc recovery when edit load rejects (#1626/#1627)", async () => {
    const source: ExpertAuthoringSource = {
      loadForEdit: async () => {
        throw new Error("library exploded");
      },
      create: async (values) => ({ ok: true, definition: definitionFor(values) }),
      update: async (_slug, values) => ({ ok: true, definition: definitionFor(values) }),
      remove: async () => ({ affectedPanels: [] }),
      affectedPanels: async () => [],
    };
    const { stdin, lastFrame, unmount } = render(
      <InputCaptureProvider>
        <DataProvider value={withAuthoring(source)}>
          <MemoryRouter initialEntries={["/", "/experts/cto/edit"]} initialIndex={1}>
            <Routes>
              <Route path="/" element={<Text>PARENT</Text>} />
              <Route
                path="/experts/:slug/edit"
                element={<ExpertFormScreen formMode="edit" theme={theme} />}
              />
            </Routes>
          </MemoryRouter>
        </DataProvider>
      </InputCaptureProvider>,
    );
    await flush();

    expect(lastFrame() ?? "").not.toContain("Loading expert");
    expect(lastFrame() ?? "").toMatch(/failed to load|error/i);

    stdin.write("\u001B");
    await waitForEscape();
    expect(lastFrame()).toContain("PARENT");
    unmount();
  });

  it("shows ←/→ change hint when editing the Kind enum field", async () => {
    const { source } = createSource(async (values) => ({
      ok: true,
      definition: definitionFor(values),
    }));
    const { stdin, lastFrame, unmount } = renderForm(source);
    await flush();

    // Kind is at index 0 — press right arrow to enter edit mode
    stdin.write("\u001B[C"); // right arrow
    await flush();

    expect(lastFrame() ?? "").toContain("←/→ change · Enter confirm · Esc cancel");
    unmount();
  });
});
