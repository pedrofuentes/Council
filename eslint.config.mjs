// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".worktrees/**",
      "coverage/**",
      "*.config.ts",
      "*.config.js",
      "*.config.mjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.test.json",
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
                "@github/copilot-sdk may only be imported from src/engine/copilot/. Use the CouncilEngine interface from src/engine/index.ts elsewhere.",
            },
          ],
        },
      ],
    },
  },
  {
    // Allow the SDK import only inside the copilot adapter directory.
    files: ["src/engine/copilot/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // Tests may import freely (including engine internals) but should still avoid SDK leaks.
    files: ["tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
);
