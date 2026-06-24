/**
 * LOCAL, opt-in, content-free TUI telemetry sink (Milestone 9.10 PR-C).
 *
 * Scope (user-approved): this is a safe LOCAL scaffold. It performs NO network
 * I/O and has NO external endpoint. When — and ONLY when — telemetry is enabled
 * (the `telemetry.enabled` config flag, off by default), it increments a small
 * set of content-free counters in a LOCAL store (see {@link ./telemetry-store}).
 *
 * Content-free by construction:
 *   - {@link TelemetryEventName} and {@link TelemetryLabel} are CLOSED unions of
 *     static identifiers, so the type system makes it impossible to pass a
 *     prompt, response, topic, panel/expert name, file path, or any other
 *     content/PII into a counter.
 *   - {@link routeToTelemetryLabel} maps a (possibly content-bearing) route to a
 *     static label; it never echoes its input, so a secret panel/expert name
 *     embedded in a pathname can never leak into a counter key.
 */

/** Content-free counter categories. */
export type TelemetryEventName = "screen.view" | "feature.used";

/**
 * Closed set of static screen / feature labels. These are the ONLY values that
 * can ever appear in a counter key — never user- or model-derived content.
 */
export type TelemetryLabel =
  | "home"
  | "onboarding"
  | "panels"
  | "experts"
  | "sessions"
  | "settings"
  | "chat"
  | "convene"
  | "conclusion"
  | "export";

export interface TelemetryEvent {
  readonly name: TelemetryEventName;
  readonly label: TelemetryLabel;
}

/**
 * The minimal local store the sink writes to. Implemented by the file-backed
 * counter store; injected so the sink stays pure and trivially testable.
 */
export interface TelemetryCounterStore {
  readonly increment: (key: string) => void;
}

export interface Telemetry {
  /** Record a content-free event. A strict NO-OP when telemetry is disabled. */
  readonly record: (event: TelemetryEvent) => void;
}

export interface CreateTelemetryOptions {
  readonly enabled: boolean;
  readonly store: TelemetryCounterStore;
}

/** Derive the content-free `name:label` counter key for an event. */
export function telemetryCounterKey(event: TelemetryEvent): string {
  return `${event.name}:${event.label}`;
}

/**
 * Build the telemetry sink. When `enabled` is false, `record` is a strict
 * NO-OP and the injected store is never written. When `enabled` is true,
 * `record` increments the local counter keyed by the event's content-free
 * `name:label`. No network I/O is performed.
 */
export function createTelemetry(options: CreateTelemetryOptions): Telemetry {
  const { enabled, store } = options;
  return {
    record: (event: TelemetryEvent): void => {
      if (!enabled) return;
      store.increment(telemetryCounterKey(event));
    },
  };
}

/**
 * Map a router pathname to a CLOSED, content-free {@link TelemetryLabel}.
 *
 * The output is always one of the static labels — the function never returns a
 * substring of `pathname`, so content-bearing segments (e.g. a panel or expert
 * name) cannot leak into a counter. Unknown routes fall back to `"home"`.
 */
export function routeToTelemetryLabel(pathname: string): TelemetryLabel {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/onboarding")) return "onboarding";
  if (pathname.startsWith("/convene")) return "convene";
  if (pathname.startsWith("/chat")) return "chat";
  if (pathname.startsWith("/panels")) return "panels";
  if (pathname.startsWith("/experts")) return "experts";
  if (pathname.startsWith("/sessions")) {
    if (pathname.endsWith("/conclude")) return "conclusion";
    if (pathname.endsWith("/export")) return "export";
    return "sessions";
  }
  if (pathname.startsWith("/settings")) return "settings";
  return "home";
}
