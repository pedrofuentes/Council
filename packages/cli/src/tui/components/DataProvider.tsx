import React from "react";

import type { PanelsDataSource } from "../adapters/panels-data.js";

export interface TuiDataSources {
  readonly panels: PanelsDataSource;
  readonly experts?: unknown;
  readonly sessions?: unknown;
}

export interface DataProviderProps {
  readonly value: TuiDataSources;
  readonly children: React.ReactNode;
}

const DataContext = React.createContext<TuiDataSources | null>(null);

export function DataProvider(props: DataProviderProps): React.ReactElement {
  return <DataContext.Provider value={props.value}>{props.children}</DataContext.Provider>;
}

export function useData(): TuiDataSources {
  const value = React.useContext(DataContext);
  if (value === null) {
    throw new Error("useData must be used within a DataProvider");
  }
  return value;
}
