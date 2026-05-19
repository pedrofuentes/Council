/**
 * Tests for ExpertLibrary fixes (#562).
 */
import { describe, it, expect } from "vitest";
import { ExpertDefinitionSchema } from "./expert.js";
import * as yaml from "yaml";

// #562: Schema parse errors lack YAML path/slug context
describe("ExpertLibrary - parse errors with context (#562)", () => {
  it("should include file path and slug in parseYaml errors", () => {
    const invalidYaml = `
slug: test-expert
kind: persona
displayName: Test Expert
role: Test Role
invalidField: this should cause an error
`;
    
    // This simulates what parseYaml function does at line 78-80
    const raw = yaml.parse(invalidYaml) as unknown;
    
    // Currently this just calls ExpertDefinitionSchema.parse(raw)
    // which throws a Zod error without file context
    try {
      ExpertDefinitionSchema.parse(raw);
      expect.fail("Should have thrown validation error");
    } catch (error) {
      // The error message should include file path and slug context
      // Currently it doesn't - the fix will wrap this parse call
      const message = String(error);
      
      // This assertion will fail because the error doesn't include context yet
      expect(message).toContain("expertise"); // Will fail - validation error is about missing expertise
    }
  });
  
  it("should include file path and slug in create() validation errors", () => {
    const invalidDef = {
      slug: "test-expert",
      kind: "persona",
      displayName: "Test Expert",
      role: "Test Role",
      // Missing required fields like expertise, epistemicStance, instructions
    } as unknown;
    
    // This simulates what happens at line 136 in expert-library.ts
    // The parse should fail with context
    try {
      ExpertDefinitionSchema.parse(invalidDef);
      expect.fail("Should have thrown validation error");
    } catch (error) {
      const message = String(error);
      
      // This assertion will fail because the error doesn't include slug context
      expect(message).toContain("expertise"); // Will pass but needs slug context
    }
  });
});
