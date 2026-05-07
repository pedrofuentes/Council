/**
 * Tests for Copilot SDK permission handlers.
 *
 * Council's Council-specific NEVER (per AGENTS.md and ADR-004): every
 * expert session MUST default to denyAll. Any tool access requires
 * explicit per-expert opt-in via panel YAML.
 *
 * RED at this commit: src/engine/copilot/permissions.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import { denyAll, scopedAllow } from "../../../../src/engine/copilot/permissions.js";

interface PermissionRequest {
  readonly toolName: string;
}

describe("denyAll permission handler", () => {
  it('returns { decision: "deny" } for any tool', async () => {
    const req: PermissionRequest = { toolName: "filesystem.write" };
    const result = await denyAll(req);
    expect(result.decision).toBe("deny");
  });

  it('returns { decision: "deny" } even for read-only-sounding tools', async () => {
    const req: PermissionRequest = { toolName: "web_fetch" };
    const result = await denyAll(req);
    expect(result.decision).toBe("deny");
  });
});

describe("scopedAllow permission handler", () => {
  it("allows tools in the whitelist", async () => {
    const handler = scopedAllow(new Set(["web_fetch"]));
    const result = await handler({ toolName: "web_fetch" });
    expect(result.decision).toBe("allow");
  });

  it("denies tools NOT in the whitelist", async () => {
    const handler = scopedAllow(new Set(["web_fetch"]));
    const result = await handler({ toolName: "filesystem.write" });
    expect(result.decision).toBe("deny");
  });

  it("empty whitelist denies everything (degenerate denyAll)", async () => {
    const handler = scopedAllow(new Set());
    const result = await handler({ toolName: "anything" });
    expect(result.decision).toBe("deny");
  });

  it("multi-entry whitelist", async () => {
    const handler = scopedAllow(new Set(["a", "b", "c"]));
    expect((await handler({ toolName: "a" })).decision).toBe("allow");
    expect((await handler({ toolName: "b" })).decision).toBe("allow");
    expect((await handler({ toolName: "c" })).decision).toBe("allow");
    expect((await handler({ toolName: "d" })).decision).toBe("deny");
  });
});
