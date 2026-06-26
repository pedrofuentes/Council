import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ExpertMemoryDataSource, ExpertMemoryView } from "../adapters/expert-memory.js";
import type { ExpertDetailView, ExpertsDataSource } from "../adapters/experts-data.js";
import { useData } from "../components/DataProvider.js";
import { useAsyncResource, type AsyncState } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ExpertDetailScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

function renderItems(label: string, items: readonly string[]): React.ReactElement | undefined {
  if (items.length === 0) return undefined;

  return (
    <>
      <Text>{toSingleLineDisplay(label)}</Text>
      {items.map((item, index) => (
        <Text key={`${label}-${String(index)}`}>{toSingleLineDisplay(`  ${item}`)}</Text>
      ))}
    </>
  );
}

function renderDetail(detail: ExpertDetailView, theme: SemanticTheme): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{theme.accent(toSingleLineDisplay(detail.displayName))}</Text>
      <Text>{toSingleLineDisplay(`Slug: ${detail.slug}`)}</Text>
      <Text>{toSingleLineDisplay(`${detail.role} [${detail.kind}]`)}</Text>
      {detail.model !== undefined ? (
        <Text>{toSingleLineDisplay(`Model: ${detail.model}`)}</Text>
      ) : undefined}
      <Text>{theme.accent("Epistemic Stance")}</Text>
      <Text>{toSingleLineDisplay(detail.epistemicStance)}</Text>
      <Text>{theme.accent("Expertise")}</Text>
      {renderItems("Weighted Evidence", detail.expertise.weightedEvidence)}
      {renderItems("Reference Cases", detail.expertise.referenceCases)}
      {renderItems("Not Expert In", detail.expertise.notExpertIn)}
      {detail.personality !== undefined ? (
        <Text>{toSingleLineDisplay(`Personality: ${detail.personality}`)}</Text>
      ) : undefined}
      {detail.personaDescription !== undefined ? (
        <Text>{toSingleLineDisplay(`Persona: ${detail.personaDescription}`)}</Text>
      ) : undefined}
      <Text>{theme.accent("Panels")}</Text>
      {detail.panels.length === 0 ? (
        <Text>{toSingleLineDisplay("  (none)")}</Text>
      ) : (
        detail.panels.map((panel, index) => (
          <Text key={`panel-${String(index)}`}>{toSingleLineDisplay(`  ${panel}`)}</Text>
        ))
      )}
    </Box>
  );
}

function renderMemoryList(
  label: string,
  items: readonly string[],
  theme: SemanticTheme,
): React.ReactElement | undefined {
  if (items.length === 0) return undefined;

  return (
    <>
      <Text>{theme.accent(toSingleLineDisplay(label))}</Text>
      {items.map((item, index) => (
        <Text key={`${label}-${String(index)}`}>{toSingleLineDisplay(`  ${item}`)}</Text>
      ))}
    </>
  );
}

function renderMemorySection(
  memory: AsyncState<ExpertMemoryView | undefined>,
  theme: SemanticTheme,
): React.ReactElement {
  if (memory.status === "loading") {
    return <Text>{theme.muted("Loading memory…")}</Text>;
  }
  if (memory.status === "error" || memory.data === undefined) {
    return <Text>{theme.muted("Memory unavailable")}</Text>;
  }

  const view = memory.data;
  if (!view.hasMemory) {
    return (
      <Box flexDirection="column">
        <Text>{theme.accent("Memory")}</Text>
        <Text>
          {theme.muted(
            toSingleLineDisplay("No learned memory yet. Train this expert to build memory."),
          )}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{theme.accent("Memory")}</Text>
      <Text>{theme.accent(toSingleLineDisplay("Communication Style"))}</Text>
      <Text>{toSingleLineDisplay(view.communicationStyle)}</Text>
      {renderMemoryList("Decision Patterns", view.decisionPatterns, theme)}
      {renderMemoryList("Biases", view.biases, theme)}
      {renderMemoryList("Vocabulary", view.vocabulary, theme)}
      <Text>
        {toSingleLineDisplay(
          `Documents: ${String(view.documentCount)} trained · ${String(
            view.totalWords,
          )} words · updated ${view.lastUpdated}`,
        )}
      </Text>
    </Box>
  );
}

export function ExpertDetailScreen(props: ExpertDetailScreenProps): React.ReactElement {
  const { slug } = useParams();
  const navigate = useNavigate();
  const data = useData();
  const experts = data.experts as ExpertsDataSource | undefined;
  const loader = React.useCallback(
    () =>
      experts
        ? experts.loadDetail(slug ?? "")
        : Promise.resolve<ExpertDetailView | undefined>(undefined),
    [experts, slug],
  );
  const state = useAsyncResource(loader);
  const expertMemory = data.expertMemory as ExpertMemoryDataSource | undefined;
  const memoryLoader = React.useCallback(
    () =>
      expertMemory
        ? expertMemory.load(slug ?? "")
        : Promise.resolve<ExpertMemoryView | undefined>(undefined),
    [expertMemory, slug],
  );
  const memoryState = useAsyncResource(memoryLoader);
  useInput(
    (input) => {
      if (input === "c" && slug !== undefined) {
        navigate(`/chat/expert/${encodeURIComponent(slug)}`);
      }
      if (input === "e" && slug !== undefined) {
        navigate(`/experts/${encodeURIComponent(slug)}/edit`);
      }
      if (input === "d" && slug !== undefined) {
        navigate(`/experts/${encodeURIComponent(slug)}/delete`);
      }
      if (
        input === "o" &&
        slug !== undefined &&
        state.status === "loaded" &&
        state.data?.kind === "persona"
      ) {
        navigate(`/experts/${encodeURIComponent(slug)}/docs`);
      }
      if (
        input === "t" &&
        slug !== undefined &&
        state.status === "loaded" &&
        state.data?.kind === "persona"
      ) {
        navigate(`/experts/${encodeURIComponent(slug)}/train`);
      }
    },
    { isActive: props.isActive ?? false },
  );

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading expert…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load expert")}</Text>;
  }

  if (state.data === undefined) {
    return <Text>{props.theme.warn("Expert not found")}</Text>;
  }

  return (
    <Box flexDirection="column">
      {renderDetail(state.data, props.theme)}
      {state.data.kind === "persona" ? renderMemorySection(memoryState, props.theme) : undefined}
      <Text>{props.theme.muted(toSingleLineDisplay("c chat · e edit · d delete"))}</Text>
      {state.data.kind === "persona" ? (
        <Text>{props.theme.muted(toSingleLineDisplay("o documents · t train"))}</Text>
      ) : undefined}
    </Box>
  );
}
