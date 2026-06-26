import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useNavigate, useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import {
  emptyExpertForm,
  type BuildResult,
  type ExpertAuthoringSource,
  type ExpertFormValues,
} from "../adapters/expert-authoring.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ExpertFormScreenProps {
  readonly theme: SemanticTheme;
  readonly formMode?: "create" | "edit";
}

type InputMode = "nav" | "edit";
type LoadState = "loading" | "loaded" | "notfound";
type FieldKind = "text" | "enum";

interface FormField {
  readonly key: keyof ExpertFormValues;
  readonly label: string;
  readonly kind: FieldKind;
  readonly options?: readonly ExpertFormValues["kind"][];
}

const KIND_OPTIONS = ["generic", "persona"] as const;
const EMPTY_VALUES = emptyExpertForm();

/**
 * Source of truth: the exact field set `validateExpertForm` rejects when empty
 * (see adapters/expert-authoring.ts — slug, displayName, role, epistemicStance,
 * weightedEvidence). The required marker must mirror validation so it never lies.
 * personaDescription is OPTIONAL even for persona experts, so it is deliberately
 * NOT marked required (validation accepts an empty persona description).
 */
const REQUIRED_FIELDS = new Set<keyof ExpertFormValues>([
  "slug",
  "displayName",
  "role",
  "epistemicStance",
  "weightedEvidence",
]);

const CREATE_UNAVAILABLE: ExpertAuthoringSource = {
  loadForEdit: async () => undefined,
  create: async () => ({
    ok: false,
    errors: [{ field: "slug", error: "Expert authoring source unavailable" }],
  }),
  update: async () => ({
    ok: false,
    errors: [{ field: "slug", error: "Expert authoring source unavailable" }],
  }),
  remove: async () => ({ affectedPanels: [] }),
  affectedPanels: async () => [],
};

const FIELDS: readonly FormField[] = [
  { key: "kind", label: "Kind", kind: "enum", options: KIND_OPTIONS },
  { key: "slug", label: "Slug", kind: "text" },
  { key: "displayName", label: "Display name", kind: "text" },
  { key: "role", label: "Role", kind: "text" },
  { key: "weightedEvidence", label: "Weighted evidence", kind: "text" },
  { key: "referenceCases", label: "Reference cases", kind: "text" },
  { key: "notExpertIn", label: "Not expert in", kind: "text" },
  { key: "epistemicStance", label: "Epistemic stance", kind: "text" },
  { key: "personaDescription", label: "Persona description", kind: "text" },
  { key: "model", label: "Model", kind: "text" },
];

export function ExpertFormScreen(props: ExpertFormScreenProps): React.ReactElement {
  const formMode = props.formMode ?? "create";
  const data = useData();
  const expertAuthoring =
    (data.expertAuthoring as ExpertAuthoringSource | undefined) ?? CREATE_UNAVAILABLE;
  const { setCaptured } = useInputCapture();
  const navigate = useNavigate();
  const params = useParams();
  const editSlug = formMode === "edit" ? params.slug : undefined;
  const [values, setValues] = React.useState<ExpertFormValues>(() => emptyExpertForm());
  const [cursor, setCursor] = React.useState(0);
  const [mode, setMode] = React.useState<InputMode>("nav");
  const [editBuffer, setEditBuffer] = React.useState("");
  const [loadState, setLoadState] = React.useState<LoadState>(
    formMode === "edit" ? "loading" : "loaded",
  );
  const [errors, setErrors] = React.useState<
    Readonly<Partial<Record<keyof ExpertFormValues, string>>>
  >({});

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  React.useEffect(() => {
    if (formMode !== "edit") {
      setLoadState("loaded");
      return;
    }

    let cancelled = false;
    setLoadState("loading");
    void expertAuthoring.loadForEdit(editSlug ?? "").then((form) => {
      if (cancelled) {
        return;
      }
      if (form === undefined) {
        setLoadState("notfound");
        return;
      }
      setValues(form);
      setErrors({});
      setLoadState("loaded");
    });

    return () => {
      cancelled = true;
    };
  }, [editSlug, expertAuthoring, formMode]);

  const visibleKind =
    mode === "edit" && editBuffer === "persona"
      ? "persona"
      : mode === "edit" && editBuffer === "generic"
        ? "generic"
        : values.kind;
  const visibleFields = React.useMemo(
    () => FIELDS.filter((field) => field.key !== "personaDescription" || visibleKind === "persona"),
    [visibleKind],
  );

  const isFieldRequired = React.useCallback(
    (field: FormField): boolean => {
      return REQUIRED_FIELDS.has(field.key);
    },
    [],
  );

  React.useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, visibleFields.length - 1)));
  }, [visibleFields.length]);

  const selected = visibleFields[cursor];

  const stageValue = React.useCallback((field: FormField, value: string): void => {
    setValues((previous) => ({ ...previous, [field.key]: value }));
    setErrors((previous) => ({ ...previous, [field.key]: undefined }));
  }, []);

  const cycleKind = React.useCallback(
    (current: ExpertFormValues["kind"], offset: number): ExpertFormValues["kind"] => {
      const index = Math.max(0, KIND_OPTIONS.indexOf(current));
      return KIND_OPTIONS[(index + offset + KIND_OPTIONS.length) % KIND_OPTIONS.length] ?? current;
    },
    [],
  );

  const commitText = React.useCallback(
    (field: FormField): void => {
      stageValue(field, editBuffer);
      setMode("nav");
    },
    [editBuffer, stageValue],
  );

  const save = React.useCallback(async (): Promise<void> => {
    const result =
      formMode === "edit"
        ? await expertAuthoring.update(editSlug ?? "", values)
        : await expertAuthoring.create(values);
    if (result.ok) {
      setErrors({});
      const destinationSlug = formMode === "edit" ? (editSlug ?? "") : values.slug.trim();
      navigate(`/experts/${encodeURIComponent(destinationSlug)}`);
      return;
    }
    const nextErrors = errorsToRecord(result);
    setErrors(nextErrors);
    const firstError = result.errors[0];
    if (firstError !== undefined) {
      const index = visibleFields.findIndex((field) => field.key === firstError.field);
      if (index >= 0) {
        setCursor(index);
      }
    }
  }, [editSlug, expertAuthoring, formMode, navigate, values, visibleFields]);

  useInput(
    (input, key) => {
      if (key.escape) {
        navigate(-1);
        return;
      }

      if (visibleFields.length === 0 || selected === undefined) {
        return;
      }

      if ((key.ctrl && input === "s") || input === "\u0013") {
        void save();
        return;
      }

      if (selected.kind === "enum" && selected.key === "kind") {
        if (key.return) {
          stageValue(selected, cycleKind(values.kind, 1));
          return;
        }
        if (key.leftArrow || key.rightArrow) {
          const offset = key.rightArrow ? 1 : -1;
          setEditBuffer(cycleKind(values.kind, offset));
          setMode("edit");
          setErrors((previous) => ({ ...previous, [selected.key]: undefined }));
          return;
        }
      }

      if (key.return && selected.kind === "text") {
        if (formMode === "edit" && selected.key === "slug") {
          return;
        }
        setEditBuffer(values[selected.key]);
        setMode("edit");
        setErrors((previous) => ({ ...previous, [selected.key]: undefined }));
        return;
      }

      const lastIndex = visibleFields.length - 1;
      if (key.downArrow || input === "j" || (key.tab && key.shift !== true)) {
        setCursor((current) => Math.min(lastIndex, current + 1));
        return;
      }
      if (key.upArrow || input === "k" || (key.tab && key.shift === true)) {
        setCursor((current) => Math.max(0, current - 1));
      }
    },
    { isActive: mode === "nav" && loadState === "loaded" },
  );

  useInput(
    (input, key) => {
      if (selected === undefined) {
        return;
      }

      if (key.escape) {
        setMode("nav");
        setEditBuffer("");
        return;
      }

      if (selected.kind === "enum" && selected.key === "kind") {
        if (key.leftArrow || key.rightArrow) {
          setEditBuffer((current) =>
            cycleKind(current === "persona" ? "persona" : "generic", key.rightArrow ? 1 : -1),
          );
          return;
        }
        if (key.return) {
          stageValue(selected, editBuffer === "persona" ? "persona" : "generic");
          setMode("nav");
          setEditBuffer("");
        }
        return;
      }

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
    },
    { isActive: mode === "edit" && loadState === "loaded" },
  );

  if (loadState === "loading") {
    return <Text>{props.theme.muted("Loading expert…")}</Text>;
  }

  if (loadState === "notfound") {
    return <Text>{props.theme.warn("Expert not found")}</Text>;
  }

  return (
    <Box flexDirection="column">
      {visibleFields.map((field, index) => {
        const error = errors[field.key];
        return (
          <React.Fragment key={field.key}>
            <FieldRow
              editBuffer={editBuffer}
              field={field}
              isDirty={values[field.key] !== EMPTY_VALUES[field.key]}
              isEditing={mode === "edit" && index === cursor}
              isRequired={isFieldRequired(field)}
              isSelected={index === cursor}
              onSubmit={() => {
                commitText(field);
              }}
              setEditBuffer={setEditBuffer}
              value={values[field.key]}
            />
            {error !== undefined ? (
              <Text>{props.theme.error(toSingleLineDisplay(`  ${error}`))}</Text>
            ) : null}
          </React.Fragment>
        );
      })}
      <Text>{props.theme.muted("↑↓ move · Enter edit · Ctrl+S save · Esc back")}</Text>
    </Box>
  );
}

interface FieldRowProps {
  readonly editBuffer: string;
  readonly field: FormField;
  readonly isDirty: boolean;
  readonly isEditing: boolean;
  readonly isRequired: boolean;
  readonly isSelected: boolean;
  readonly onSubmit: () => void;
  readonly setEditBuffer: (value: string) => void;
  readonly value: string;
}

function FieldRow(props: FieldRowProps): React.ReactElement {
  const labelPrefix = props.isDirty ? "*" : "";
  const requiredSuffix = props.isRequired ? " (required)" : "";
  const label = toSingleLineDisplay(`${labelPrefix}${props.field.label}${requiredSuffix}`);
  const displayValue = props.isEditing ? props.editBuffer : props.value;

  if (props.isEditing && props.field.kind === "text") {
    return (
      <Box>
        <Text inverse={props.isSelected}>{toSingleLineDisplay(`  ${label}: `)}</Text>
        <TextInput
          focus={false}
          onChange={props.setEditBuffer}
          onSubmit={props.onSubmit}
          showCursor={false}
          value={toSingleLineDisplay(props.editBuffer)}
        />
      </Box>
    );
  }

  return (
    <Text inverse={props.isSelected}>{toSingleLineDisplay(`  ${label}: ${displayValue}`)}</Text>
  );
}

function errorsToRecord(
  result: Extract<BuildResult, { readonly ok: false }>,
): Readonly<Partial<Record<keyof ExpertFormValues, string>>> {
  const next: Partial<Record<keyof ExpertFormValues, string>> = {};
  for (const item of result.errors) {
    next[item.field] = toSingleLineDisplay(item.error);
  }
  return next;
}
