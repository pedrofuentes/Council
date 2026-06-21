---
title: "council review"
description: "Run the built-in code-review expert panel over a diff and print the review."
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Run the built-in code-review expert panel over a diff and print the review. The diff is SENT to the configured AI engine (e.g. Copilot); use --engine mock to run offline.

## Usage

```text
council review [options]
```

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--diff-file <path>` | Read the unified diff from a file, or \`-\` to read stdin. When omitted, Council reviews \`git diff \<base\>\` (your local changes). | — |
| `--base <ref>` | Git ref to diff the working tree against when --diff-file is omitted | `HEAD` |
| `--engine <kind>` | Engine to use (default: from config) (choices: `copilot`, `mock`, `openai`, `anthropic`) | — |
| `--format <kind>` | Output format (choices: `auto`, `json`, `plain`) | `auto` |
| `--max-rounds <n>` | Max debate rounds (default: the code-review panel's own default) | — |
| `--max-words <n>` | Soft per-response word cap | `250` |
