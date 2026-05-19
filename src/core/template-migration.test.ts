/**
 * Tests for template-migration fixes (#563).
 */
import { describe, it, expect, vi } from "vitest";
import { ExpertDefinitionSchema } from "./expert.js";

// #563: Invalid inline expert silently falls back to slug path
describe("parseOnDiskPanel - invalid inline expert warning (#563)", () => {
  it("should surface schema error instead of silently falling back to slug", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    
    // Simulate an inline expert object that fails schema validation
    const invalidExpert = {
      slug: "test-expert",
      kind: "persona",
      // Missing displayName - will fail validation
    };
    
    // This is what happens at line 499 in template-migration.ts
    const parsed = ExpertDefinitionSchema.safeParse(invalidExpert);
    
    // Currently the code just silently falls back to slug reference
    // The fix should log a warning when safeParse fails
    if (!parsed.success) {
      // This should happen but currently doesn't
      // console.warn(...);
    }
    
    // This assertion will fail because no warning is logged yet
    expect(consoleWarnSpy).toHaveBeenCalled();
    
    consoleWarnSpy.mockRestore();
  });
  
  it("should still process valid inline experts successfully", () => {
    const validExpert = {
      slug: "valid-expert",
      kind: "persona",
      displayName: "Valid Expert",
      instructions: "Test instructions",
    };
    
    const parsed = ExpertDefinitionSchema.safeParse(validExpert);
    
    // Valid experts should still parse successfully
    expect(parsed.success).toBe(true);
  });
});
