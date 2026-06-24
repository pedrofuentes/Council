/**
 * Tests for the LOCAL, opt-in, content-free TUI telemetry sink.
 *
 * Contract (Milestone 9.10 PR-C — user-approved scope: LOCAL ONLY, no network):
 *   - `createTelemetry({ enabled, store })` returns a sink whose `record(event)`
 *     increments a LOCAL counter via the injected store.
 *   - When `enabled` is false, `record` is a strict NO-OP: the injected store is
 *     NEVER written.
 *   - When `enabled` is true, `record` increments the counter for the event,
 *     keyed by a content-free `name:label` string. The only thing that ever
 *     reaches the store is that static key — NO prompts, responses, topics,
 *     panel/expert names, file paths, or any other content/PII.
 *   - The sink performs NO network I/O (asserted via a spied global `fetch`).
 *   - `routeToTelemetryLabel(pathname)` maps a (possibly content-bearing) route
 *     to one of a CLOSED set of static labels — it never echoes the input, so a
 *     secret panel/expert name embedded in a path can never leak into a counter.
 *
 * RED at this commit: src/tui/lib/telemetry.ts does not exist yet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTelemetry,
  routeToTelemetryLabel,
  telemetryCounterKey,
  type TelemetryCounterStore,
  type TelemetryEvent,
  type TelemetryLabel,
} from "../../../src/tui/lib/telemetry.js";

/** A spy store that records every counter key it is asked to increment. */
function createSpyStore(): TelemetryCounterStore & { readonly keys: readonly string[] } {
  const keys: string[] = [];
  return {
    keys,
    increment: (key: string): void => {
      keys.push(key);
    },
  };
}

/** Strict content-free key shape: lowercase dotted segments + a single colon. */
const CONTENT_FREE_KEY = /^[a-z]+(?:\.[a-z]+)*:[a-z]+$/;

describe("telemetryCounterKey", () => {
  it("derives a content-free `name:label` key", () => {
    expect(telemetryCounterKey({ name: "screen.view", label: "chat" })).toBe("screen.view:chat");
    expect(telemetryCounterKey({ name: "feature.used", label: "export" })).toBe(
      "feature.used:export",
    );
  });
});

describe("createTelemetry", () => {
  it("is a strict NO-OP when telemetry is disabled — the store is never written", () => {
    const store = createSpyStore();
    const increment = vi.spyOn(store, "increment");
    const telemetry = createTelemetry({ enabled: false, store });

    telemetry.record({ name: "screen.view", label: "home" });
    telemetry.record({ name: "feature.used", label: "convene" });

    expect(increment).not.toHaveBeenCalled();
    expect(store.keys).toEqual([]);
  });

  it("increments the local counter for the event when enabled", () => {
    const store = createSpyStore();
    const telemetry = createTelemetry({ enabled: true, store });

    telemetry.record({ name: "screen.view", label: "chat" });
    telemetry.record({ name: "screen.view", label: "chat" });
    telemetry.record({ name: "feature.used", label: "export" });

    expect(store.keys).toEqual(["screen.view:chat", "screen.view:chat", "feature.used:export"]);
  });

  it("only ever passes a single content-free string key to the store (no content/PII)", () => {
    const store = createSpyStore();
    const increment = vi.spyOn(store, "increment");
    const telemetry = createTelemetry({ enabled: true, store });

    const events: readonly TelemetryEvent[] = [
      { name: "screen.view", label: "panels" },
      { name: "feature.used", label: "convene" },
    ];
    for (const event of events) telemetry.record(event);

    for (const call of increment.mock.calls) {
      expect(call).toHaveLength(1);
      const [key] = call;
      expect(typeof key).toBe("string");
      expect(key).toMatch(CONTENT_FREE_KEY);
    }
  });

  it("performs NO network I/O when recording", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = createSpyStore();
    const telemetry = createTelemetry({ enabled: true, store });

    telemetry.record({ name: "screen.view", label: "settings" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("routeToTelemetryLabel", () => {
  const cases: readonly { readonly pathname: string; readonly label: TelemetryLabel }[] = [
    { pathname: "/", label: "home" },
    { pathname: "/onboarding", label: "onboarding" },
    { pathname: "/convene/some-panel", label: "convene" },
    { pathname: "/convene/some-panel/run", label: "convene" },
    { pathname: "/chats", label: "chat" },
    { pathname: "/chat/expert/some-slug", label: "chat" },
    { pathname: "/chat/panel/some-name", label: "chat" },
    { pathname: "/panels", label: "panels" },
    { pathname: "/panels/some-name", label: "panels" },
    { pathname: "/experts", label: "experts" },
    { pathname: "/experts/some-slug", label: "experts" },
    { pathname: "/sessions", label: "sessions" },
    { pathname: "/sessions/some-id", label: "sessions" },
    { pathname: "/sessions/some-id/conclude", label: "conclusion" },
    { pathname: "/sessions/some-id/export", label: "export" },
    { pathname: "/settings", label: "settings" },
    { pathname: "/totally-unknown-route", label: "home" },
  ];

  for (const { pathname, label } of cases) {
    it(`maps ${pathname} -> ${label}`, () => {
      expect(routeToTelemetryLabel(pathname)).toBe(label);
    });
  }

  it("never leaks a content-bearing path segment into the label", () => {
    const secret = "super-secret-panel-name";
    const label = routeToTelemetryLabel(`/panels/${secret}`);

    expect(label).toBe("panels");
    expect(label).not.toContain(secret);
  });

  it("returns a key that stays content-free even for content-bearing routes", () => {
    const key = telemetryCounterKey({
      name: "screen.view",
      label: routeToTelemetryLabel("/experts/another-secret-slug"),
    });

    expect(key).toBe("screen.view:experts");
    expect(key).toMatch(CONTENT_FREE_KEY);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
