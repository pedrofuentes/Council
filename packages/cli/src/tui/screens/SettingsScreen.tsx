import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import {
  validateField,
  type SettingsDataSource,
  type SettingsFieldState,
} from "../adapters/config-settings.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface SettingsScreenProps {
  readonly theme: SemanticTheme;
}

const EMPTY: () => Promise<readonly SettingsFieldState[]> = async () => [];

type SettingsMode = "nav" | "edit";

interface ValidatedChange {
  readonly path: string;
  readonly value: string | number | boolean;
}

export function SettingsScreen(props: SettingsScreenProps): React.ReactElement {
  const data = useData();
  const settings = data.settings as SettingsDataSource | undefined;
  const load = settings?.load ?? EMPTY;
  const state = useAsyncResource(load);
  const { setCaptured } = useInputCapture();
  const navigate = useNavigate();
  const [cursor, setCursor] = React.useState(0);
  const [mode, setMode] = React.useState<SettingsMode>("nav");
  const [draft, setDraft] = React.useState<ReadonlyMap<string, string>>(new Map());
  const [fieldError, setFieldError] = React.useState<string | undefined>(undefined);
  const [savedAt, setSavedAt] = React.useState<number | undefined>(undefined);
  const [editBuffer, setEditBuffer] = React.useState("");
  const [originals, setOriginals] = React.useState<ReadonlyMap<string, string>>(new Map());

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  React.useEffect(() => {
    if (state.status === "loaded") {
      setOriginals((previous) => {
        const next = new Map(previous);
        for (const field of state.data) {
          if (!next.has(field.path)) {
            next.set(field.path, field.value);
          }
        }
        return next;
      });
    }
  }, [state]);

  const originalValue = React.useCallback(
    (field: SettingsFieldState): string => originals.get(field.path) ?? field.value,
    [originals],
  );

  const effectiveValue = React.useCallback(
    (field: SettingsFieldState): string => draft.get(field.path) ?? originalValue(field),
    [draft, originalValue],
  );

  const isDirty = React.useCallback(
    (field: SettingsFieldState): boolean =>
      draft.has(field.path) && draft.get(field.path) !== originalValue(field),
    [draft, originalValue],
  );

  const stageValue = React.useCallback((field: SettingsFieldState, value: string): void => {
    setDraft((previous) => {
      const next = new Map(previous);
      next.set(field.path, value);
      return next;
    });
  }, []);

  const commitText = React.useCallback(
    (field: SettingsFieldState): void => {
      const result = validateField(field, editBuffer);
      if (result.ok) {
        stageValue(field, editBuffer);
        setFieldError(undefined);
        setMode("nav");
        return;
      }
      setFieldError(toSingleLineDisplay(result.error));
    },
    [editBuffer, stageValue],
  );

  const saveDraft = React.useCallback(async (): Promise<void> => {
    if (state.status !== "loaded") return;

    const dirtyFields = state.data.filter(isDirty);
    const changes: ValidatedChange[] = [];
    const savedRaw = new Map<string, string>();

    for (const field of dirtyFields) {
      const raw = draft.get(field.path);
      if (raw === undefined) continue;
      const result = validateField(field, raw);
      if (!result.ok) {
        setCursor(state.data.indexOf(field));
        setMode("nav");
        setFieldError(toSingleLineDisplay(result.error));
        return;
      }
      changes.push({ path: field.path, value: result.value });
      savedRaw.set(field.path, raw);
    }

    try {
      await settings?.save(changes);
      setOriginals((previous) => {
        const next = new Map(previous);
        for (const [path, value] of savedRaw) {
          next.set(path, value);
        }
        return next;
      });
      setDraft(new Map());
      setFieldError(undefined);
      setSavedAt(Date.now());
    } catch (error) {
      setFieldError(toSingleLineDisplay(String(error)));
    }
  }, [draft, isDirty, settings, state]);

  useInput(
    (input, key) => {
      if (key.escape) {
        navigate(-1);
        return;
      }

      if (state.status !== "loaded" || state.data.length === 0) {
        return;
      }

      if ((key.ctrl && input === "s") || input === "\u0013") {
        void saveDraft();
        return;
      }

      const selected = state.data[cursor];
      if (key.return && selected !== undefined) {
        setMode("edit");
        setEditBuffer(effectiveValue(selected));
        setFieldError(undefined);
        return;
      }

      const lastIndex = state.data.length - 1;
      if (key.downArrow || input === "j" || (key.tab && key.shift !== true)) {
        setCursor((c) => Math.min(lastIndex, c + 1));
        return;
      }
      if (key.upArrow || input === "k" || (key.tab && key.shift === true)) {
        setCursor((c) => Math.max(0, c - 1));
      }
    },
    { isActive: mode === "nav" },
  );

  useInput(
    (input, key) => {
      if (state.status !== "loaded" || state.data.length === 0) {
        return;
      }

      const selected = state.data[cursor];
      if (selected === undefined) {
        return;
      }

      if (key.escape) {
        setMode("nav");
        setFieldError(undefined);
        return;
      }

      if (selected.kind === "string" || selected.kind === "number") {
        if (key.return) {
          commitText(selected);
          return;
        }
        if (key.backspace || key.delete) {
          setEditBuffer((value) => value.slice(0, -1));
          return;
        }
        if (
          input.length > 0 &&
          !key.ctrl &&
          !key.meta &&
          !key.upArrow &&
          !key.downArrow &&
          !key.leftArrow &&
          !key.rightArrow &&
          !key.tab
        ) {
          setEditBuffer((value) => value + input);
        }
        return;
      }

      if (selected.kind === "boolean") {
        if (key.return || input === " ") {
          stageValue(selected, effectiveValue(selected) === "true" ? "false" : "true");
          setMode("nav");
        }
        return;
      }

      const options = selected.options ?? [];
      if (options.length === 0) {
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const currentIndex = Math.max(0, options.indexOf(editBuffer));
        const offset = key.rightArrow ? 1 : -1;
        const nextIndex = (currentIndex + offset + options.length) % options.length;
        setEditBuffer(options[nextIndex] ?? editBuffer);
        setFieldError(undefined);
        return;
      }
      if (key.return) {
        stageValue(selected, editBuffer);
        setMode("nav");
        setFieldError(undefined);
      }
    },
    { isActive: mode === "edit" },
  );

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading settings…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load settings")}</Text>;
  }

  let previousSection: string | undefined;

  return (
    <Box flexDirection="column">
      {state.data.map((field, index) => {
        const showSection = field.section !== previousSection;
        previousSection = field.section;
        return (
          <React.Fragment key={field.path}>
            {showSection ? (
              <Text>{props.theme.accent(toSingleLineDisplay(field.section))}</Text>
            ) : null}
            <FieldRow
              editBuffer={editBuffer}
              field={field}
              isDirty={isDirty(field)}
              isEditing={mode === "edit" && index === cursor}
              isSelected={index === cursor}
              onSubmit={() => {
                commitText(field);
              }}
              setEditBuffer={setEditBuffer}
              value={effectiveValue(field)}
            />
            {index === cursor && fieldError !== undefined ? (
              <Text>{props.theme.error(toSingleLineDisplay(`  ${fieldError}`))}</Text>
            ) : null}
          </React.Fragment>
        );
      })}
      {savedAt !== undefined ? <Text>{props.theme.accent("Saved")}</Text> : null}
      <Text>{props.theme.muted(settingsHint(mode, state.data[cursor]))}</Text>
    </Box>
  );
}

function settingsHint(mode: SettingsMode, field: SettingsFieldState | undefined): string {
  if (mode === "nav" || field === undefined) {
    return "↑↓ move · Enter edit · Ctrl+S save · Esc back";
  }
  if (field.kind === "enum") {
    return "←/→ change · Enter confirm · Esc cancel";
  }
  if (field.kind === "boolean") {
    return "Enter/Space toggle · Esc cancel";
  }
  return "type · Enter confirm · Esc cancel";
}

interface FieldRowProps {
  readonly editBuffer: string;
  readonly field: SettingsFieldState;
  readonly isDirty: boolean;
  readonly isEditing: boolean;
  readonly isSelected: boolean;
  readonly onSubmit: () => void;
  readonly setEditBuffer: (value: string) => void;
  readonly value: string;
}

function FieldRow(props: FieldRowProps): React.ReactElement {
  const labelPrefix = props.isDirty ? "*" : "";
  const label = toSingleLineDisplay(`${labelPrefix}${props.field.label}`);

  if (props.isEditing && (props.field.kind === "string" || props.field.kind === "number")) {
    return (
      <Box>
        <Text inverse={props.isSelected}>{toSingleLineDisplay(`  ${label}: `)}</Text>
        <TextInput
          focus={false}
          onChange={props.setEditBuffer}
          showCursor={false}
          onSubmit={props.onSubmit}
          value={toSingleLineDisplay(props.editBuffer)}
        />
      </Box>
    );
  }

  return (
    <Text inverse={props.isSelected}>
      {toSingleLineDisplay(`  ${label}: ${props.isEditing ? props.editBuffer : props.value}`)}
    </Text>
  );
}
