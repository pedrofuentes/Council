import React from "react";

import type { ExpertsDataSource } from "../adapters/experts-data.js";
import type { ExpertAuthoringSource } from "../adapters/expert-authoring.js";
import type { ExpertDocumentsDataSource } from "../adapters/expert-documents.js";
import type { ExpertMemoryDataSource } from "../adapters/expert-memory.js";
import type { ExpertTrainingDataSource } from "../adapters/expert-training.js";
import type { OnboardingDataSource } from "../adapters/onboarding.js";
import type { PanelAuthoringDataSource } from "../adapters/panel-authoring.js";
import type { PanelComposeDataSource } from "../adapters/panel-compose.js";
import type { PanelsDataSource } from "../adapters/panels-data.js";
import type { SettingsDataSource } from "../adapters/config-settings.js";
import type { SessionsDataSource } from "../adapters/sessions-data.js";
import type { ConcludeDataSource } from "../adapters/conclude.js";
import type { ExportViewSource } from "../adapters/export-view.js";
import type { ConveneDataSource } from "../adapters/convene.js";
import type { ChatSessionDataSource } from "../adapters/chat-session.js";
import type { ChatEngineSource } from "../adapters/chat-engine-session.js";
import type { ChatsDataSource } from "../adapters/chats-data.js";
import type { Telemetry } from "../lib/telemetry.js";

export interface TuiDataSources {
  readonly panels: PanelsDataSource;
  readonly panelAuthoring?: PanelAuthoringDataSource;
  readonly panelCompose?: PanelComposeDataSource;
  readonly experts?: ExpertsDataSource;
  readonly expertAuthoring?: ExpertAuthoringSource;
  readonly documents?: ExpertDocumentsDataSource;
  readonly expertMemory?: ExpertMemoryDataSource;
  readonly training?: ExpertTrainingDataSource;
  readonly settings?: SettingsDataSource;
  readonly sessions?: SessionsDataSource;
  readonly convene?: ConveneDataSource;
  readonly conclude?: ConcludeDataSource;
  readonly export?: ExportViewSource;
  readonly chat?: ChatSessionDataSource;
  readonly chatEngine?: ChatEngineSource;
  readonly chats?: ChatsDataSource;
  readonly onboarding?: OnboardingDataSource;
  /**
   * LOCAL, opt-in, content-free telemetry sink. Present only when
   * `telemetry.enabled` is set; absent (and thus a no-op via optional chaining)
   * otherwise. Records content-free screen/feature counters to a local store.
   */
  readonly telemetry?: Telemetry;
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

/**
 * Non-throwing variant of {@link useData}. Returns `null` when rendered outside
 * a {@link DataProvider} (e.g. shell-only unit tests). Use this for optional
 * concerns — like the opt-in telemetry sink — that must not require a provider.
 */
export function useOptionalData(): TuiDataSources | null {
  return React.useContext(DataContext);
}
