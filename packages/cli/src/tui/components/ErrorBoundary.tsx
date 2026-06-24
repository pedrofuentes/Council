import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";

export interface ErrorBoundaryProps {
  readonly onError: (error: Error) => void;
  readonly fallback?: React.ReactNode;
  readonly children: React.ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: Error | null;
  readonly componentStack: string | null;
}

/**
 * i18n-ready fallback copy. Keeping the strings as named constants (rather than
 * inline literals) centralises them for future translation and lets tests pin
 * the contract.
 */
export const ERROR_BOUNDARY_HEADLINE = "Council hit an unexpected error and is exiting.";
export const ERROR_BOUNDARY_DETAIL_LABEL = "Details:";
export const ERROR_BOUNDARY_LOCATION_LABEL = "Where:";

const INITIAL_STATE: ErrorBoundaryState = {
  hasError: false,
  error: null,
  componentStack: null,
};

/**
 * Reduce a (possibly multi-line, untrusted) React component stack to its first
 * meaningful frame. The full stack is noisy and the names in it are untrusted,
 * so the fallback shows only a single summarising frame; the caller still runs
 * the result through `toSingleLineDisplay` at the sink.
 */
function firstStackFrame(componentStack: string): string {
  return (
    componentStack
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/**
 * Tiered, sanitised crash fallback. Tier 1 is a stable headline; tier 2 is the
 * secondary diagnostic detail (the caught message and, when captured, the
 * component-stack frame). Every untrusted string is collapsed/stripped with
 * `toSingleLineDisplay` so a crafted error message cannot forge extra lines or
 * inject terminal-control sequences into the exit screen.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = INITIAL_STATE;
  }

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ componentStack: errorInfo.componentStack ?? null });
    this.props.onError(error);
  }

  public override render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    const message = this.state.error?.message ?? "";
    const location =
      this.state.componentStack !== null ? firstStackFrame(this.state.componentStack) : "";

    return (
      <Box flexDirection="column">
        <Text>{toSingleLineDisplay(ERROR_BOUNDARY_HEADLINE)}</Text>
        {message.length > 0 ? (
          <Text dimColor>{toSingleLineDisplay(`${ERROR_BOUNDARY_DETAIL_LABEL} ${message}`)}</Text>
        ) : null}
        {location.length > 0 ? (
          <Text dimColor>
            {toSingleLineDisplay(`${ERROR_BOUNDARY_LOCATION_LABEL} ${location}`)}
          </Text>
        ) : null}
      </Box>
    );
  }
}
