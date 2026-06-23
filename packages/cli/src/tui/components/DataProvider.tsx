import React from "react";

import type { ExpertsDataSource } from "../adapters/experts-data.js";
import type { ExpertAuthoringSource } from "../adapters/expert-authoring.js";
import type { ExpertDocumentsDataSource } from "../adapters/expert-documents.js";
import type { PanelsDataSource } from "../adapters/panels-data.js";
import type { SettingsDataSource } from "../adapters/config-settings.js";
import type { SessionsDataSource } from "../adapters/sessions-data.js";

export interface TuiDataSources {
  readonly panels: PanelsDataSource;
  readonly experts?: ExpertsDataSource;
  readonly expertAuthoring?: ExpertAuthoringSource;
  readonly documents?: ExpertDocumentsDataSource;
  readonly settings?: SettingsDataSource;
  readonly sessions?: SessionsDataSource;
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
