import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import {
  DataProvider,
  type TuiDataSources,
  useData,
} from "../../../src/tui/components/DataProvider.js";
import { ErrorBoundary } from "../../../src/tui/components/ErrorBoundary.js";

function Consumer(): React.ReactElement {
  const data = useData();
  return <Text>panels={String(Boolean(data.panels))}</Text>;
}

describe("DataProvider", () => {
  it("provides the value to useData", () => {
    const value = { panels: { loadList: async () => [] } } satisfies TuiDataSources;
    const { lastFrame } = render(
      <DataProvider value={value}>
        <Consumer />
      </DataProvider>,
    );

    expect(lastFrame()).toContain("panels=true");
  });

  it("throws when useData is rendered without a provider", () => {
    const onError = vi.fn();
    const { lastFrame } = render(
      <ErrorBoundary onError={onError} fallback={<Text>missing provider</Text>}>
        <Consumer />
      </ErrorBoundary>,
    );

    expect(lastFrame()).toContain("missing provider");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "useData must be used within a DataProvider" }),
    );
  });
});
