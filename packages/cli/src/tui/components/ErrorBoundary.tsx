import React from "react";
import { Text } from "ink";

export interface ErrorBoundaryProps {
  readonly onError: (error: Error) => void;
  readonly fallback?: React.ReactNode;
  readonly children: React.ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  public override render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? <Text>Council hit an unexpected error and is exiting.</Text>;
    }
    return this.props.children;
  }
}
