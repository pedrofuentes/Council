import React from "react";
import { Box, Text, useInput } from "ink";
import { useLocation, useNavigate } from "react-router";

import type { ExportFormat } from "../../cli/commands/export.js";
import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ExportViewSource } from "../adapters/export-view.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { ScrollView } from "../components/lists/ScrollView.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ExportOverlayProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

const FORMAT_OPTIONS: readonly ExportFormat[] = ["markdown", "json", "adr", "share"];

/**
 * Static, drift-guarded labels for the picker. A `Record<ExportFormat, …>`
 * makes adding/removing an {@link ExportFormat} a compile error here, keeping
 * the overlay in lockstep with the CLI's format list (parity follow-up #1670).
 */
const FORMAT_LABELS: Record<ExportFormat, string> = {
  markdown: "Markdown",
  json: "JSON (NDJSON)",
  adr: "ADR",
  share: "Share",
};

type Phase =
  | { readonly status: "pick" }
  | { readonly status: "loading" }
  | { readonly status: "preview"; readonly format: ExportFormat; readonly content: string }
  | {
      readonly status: "saved";
      readonly format: ExportFormat;
      readonly content: string;
      readonly path: string;
    }
  | {
      readonly status: "writeError";
      readonly format: ExportFormat;
      readonly content: string;
      readonly message: string;
    }
  | { readonly status: "unavailable"; readonly message: string };

function errorMessage(error: unknown): string {
  return toSingleLineDisplay(error instanceof Error ? error.message : String(error));
}

/** Derive a filesystem-safe slug from an untrusted (LLM-authored) panel name. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "council-export";
}

function outputPathFor(panelName: string, format: ExportFormat): string {
  const extension = format === "json" ? "ndjson" : "md";
  return `${slugify(panelName)}-${format}.${extension}`;
}

/**
 * Collapse the rendered preview into one safe display line per row. The content
 * is transcript-derived (untrusted), so every row goes through
 * `toSingleLineDisplay` — the single-line sanitizer that strips control chars
 * AND collapses CR / LF / U+2028 / U+2029 — to neutralise CR-overwrite and
 * row-forging in the scroll sink. A newline-preserving sanitizer would leave
 * those characters intact and must not be used here.
 */
function previewRows(content: string): readonly string[] {
  return content.split("\n").map(toSingleLineDisplay);
}

/**
 * Overlay to export a session/panel transcript from inside the TUI: pick a
 * format → preview the sanitized render → optionally write it to a file. The
 * single write is gated on a loaded, not-in-flight preview; Esc is idle-gated so
 * it never abandons an in-flight write.
 */
export function ExportOverlay(props: ExportOverlayProps): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const data = useData();
  const exportSource = data.export as ExportViewSource | undefined;
  const { setCaptured } = useInputCapture();

  const state = location.state as {
    readonly panelName?: string;
    readonly debateId?: string;
  } | null;
  const panelName = state?.panelName ?? "";
  const debateId = state?.debateId;

  const [cursor, setCursor] = React.useState(0);
  const cursorRef = React.useRef(0);
  const [phase, setPhase] = React.useState<Phase>({ status: "pick" });
  const inFlight = React.useRef(false);
  const unmounted = React.useRef(false);

  // Keep a ref in lockstep with the cursor so a burst of nav keys followed by
  // Enter in the same render tick selects the latest position (state reads in
  // the input closure would otherwise be stale).
  const moveCursor = React.useCallback((delta: number): void => {
    const next = Math.min(Math.max(cursorRef.current + delta, 0), FORMAT_OPTIONS.length - 1);
    cursorRef.current = next;
    setCursor(next);
  }, []);

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  React.useEffect(() => {
    return () => {
      unmounted.current = true;
    };
  }, []);

  const loadPreview = React.useCallback(
    (format: ExportFormat): void => {
      if (exportSource === undefined) {
        setPhase({ status: "unavailable", message: "Export source unavailable." });
        return;
      }
      setPhase({ status: "loading" });
      void exportSource
        .render(panelName, format, debateId)
        .then((content) => {
          if (unmounted.current) return;
          if (content === null) {
            setPhase({ status: "unavailable", message: "No transcript to export." });
            return;
          }
          setPhase({ status: "preview", format, content });
        })
        .catch((error: unknown) => {
          if (unmounted.current) return;
          setPhase({ status: "unavailable", message: errorMessage(error) });
        });
    },
    [exportSource, panelName, debateId],
  );

  const writePreview = React.useCallback((): void => {
    if (inFlight.current) return;
    if (exportSource === undefined) return;
    if (phase.status !== "preview" && phase.status !== "saved" && phase.status !== "writeError") {
      return;
    }
    const { format, content } = phase;
    const path = outputPathFor(panelName, format);
    inFlight.current = true;
    void exportSource
      .writeFile(path, content)
      .then(() => {
        if (unmounted.current) return;
        // LOCAL, content-free counter: an export was actually written. No path,
        // panel name, or content is recorded — only the static feature label.
        data.telemetry?.record({ name: "feature.used", label: "export" });
        setPhase({ status: "saved", format, content, path });
      })
      .catch((error: unknown) => {
        if (unmounted.current) return;
        setPhase({ status: "writeError", format, content, message: errorMessage(error) });
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [exportSource, panelName, phase]);

  useInput(
    (input, key) => {
      if (key.escape) {
        // Idle-gated: never abandon an in-flight write.
        if (inFlight.current) return;
        navigate(-1);
        return;
      }
      if (phase.status === "pick") {
        if (input === "j" || key.downArrow) {
          moveCursor(1);
          return;
        }
        if (input === "k" || key.upArrow) {
          moveCursor(-1);
          return;
        }
        if (key.return) {
          const format = FORMAT_OPTIONS[cursorRef.current];
          if (format !== undefined) loadPreview(format);
        }
        return;
      }
      if (key.return) {
        writePreview();
      }
    },
    { isActive: props.isActive ?? false },
  );

  const header = <Text>{props.theme.accent(toSingleLineDisplay(`Export · ${panelName}`))}</Text>;

  if (phase.status === "unavailable") {
    return (
      <Box flexDirection="column">
        {header}
        <Text>{props.theme.warn(toSingleLineDisplay(phase.message))}</Text>
        <Text>{props.theme.muted(toSingleLineDisplay("Esc back"))}</Text>
      </Box>
    );
  }

  if (phase.status === "pick") {
    return (
      <Box flexDirection="column">
        {header}
        <Text>{props.theme.muted(toSingleLineDisplay("Choose a format:"))}</Text>
        {FORMAT_OPTIONS.map((format, index) => (
          <Text key={format} inverse={index === cursor}>
            {toSingleLineDisplay(FORMAT_LABELS[format])}
          </Text>
        ))}
        <Text>{props.theme.muted(toSingleLineDisplay("j/k move · Enter select · Esc back"))}</Text>
      </Box>
    );
  }

  if (phase.status === "loading") {
    return (
      <Box flexDirection="column">
        {header}
        <Text>{props.theme.muted(toSingleLineDisplay("Rendering…"))}</Text>
        <Text>{props.theme.muted(toSingleLineDisplay("Esc back"))}</Text>
      </Box>
    );
  }

  const rows = previewRows(phase.content);

  return (
    <Box flexDirection="column">
      {header}
      <Text>
        {props.theme.muted(toSingleLineDisplay(`Format: ${FORMAT_LABELS[phase.format]}`))}
      </Text>
      <ScrollView items={rows} height={14} />
      {phase.status === "saved" ? (
        <Text>{props.theme.success(toSingleLineDisplay(`Saved → ${phase.path}`))}</Text>
      ) : null}
      {phase.status === "writeError" ? (
        <Text>{props.theme.error(toSingleLineDisplay(`Write failed: ${phase.message}`))}</Text>
      ) : null}
      <Text>{props.theme.muted(toSingleLineDisplay("Enter write to file · Esc back"))}</Text>
    </Box>
  );
}
