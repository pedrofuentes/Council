// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".worktrees/**",
      "**/coverage/**",
      "**/*.config.ts",
      "**/*.config.js",
      "**/*.config.mjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      parserOptions: {
        project: "./packages/cli/tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@github/copilot-sdk", "@github/copilot-sdk/*"],
              message:
                "@github/copilot-sdk may only be imported from packages/cli/src/engine/copilot/. Use the CouncilEngine interface from packages/cli/src/engine/index.ts elsewhere.",
            },
          ],
        },
      ],
      // eslint 10's updated `eslint:recommended` newly enables these two rules.
      // Deferred from the eslint 9->10 bump to keep that a pure, behavior-preserving
      // tooling change. Adoption is tracked separately:
      //   preserve-caught-error  -> #1231 (adding { cause } changes error behavior; needs tests)
      //   no-useless-assignment  -> #1232 (some flagged stores are intentional/defensive)
      "preserve-caught-error": "off",
      "no-useless-assignment": "off",
    },
  },
  {
    // Allow the SDK import only inside the single adapter file (per AGENTS.md
    // §Boundaries and DECISIONS.md ADR-003). Sibling files in
    // engine/copilot/ (session-pool, permissions, etc.) must talk to the
    // adapter, not the SDK directly.
    files: ["**/engine/copilot/adapter.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // Tests may import freely (including engine internals) but should still avoid SDK leaks.
    files: ["**/tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
);
