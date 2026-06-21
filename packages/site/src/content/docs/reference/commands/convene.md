---
title: "council convene"
description: "Run a panel debate on a topic and persist results to the local DB."
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Run a panel debate on a topic and persist results to the local DB. For one-shot questions use \`council ask\`. For conversation use \`council chat\`.

## Usage

```text
council convene [options] [topic]
```

## Arguments

| Argument | Description | Default |
| --- | --- | --- |
| `[topic]` | The topic / question for the panel to debate (optional when --prompt-file is used) | — |

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--prompt-file <path>` | Read the topic VERBATIM from a file (or \`-\` for stdin) instead of the positional argument. Bypasses the shell so \`$\`, backticks, and values like \`$180K\` survive intact. Mutually exclusive with the positional \<topic\>. | — |
| `-p, --panel <name>` | Use a built-in or custom panel template (alias: --template). \*\*Omit to let Council auto-design an expert panel from your topic.\*\* | — |
| `--template <name>` | Use a built-in or custom panel template (alias: --panel). \*\*Omit to let Council auto-design an expert panel from your topic.\*\* | — |
| `--experts <slugs...>` | Expert slugs from the library (space- or comma-separated, repeatable). Bypasses both --template and auto-compose. | — |
| `--engine <kind>` | Engine to use (default: from config) (choices: `copilot`, `mock`, `openai`, `anthropic`) | — |
| `--format <kind>` | Output format (auto picks Ink TUI on TTY, plain text otherwise) (choices: `auto`, `json`, `plain`) | `auto` |
| `--max-rounds <n>` | Max rounds (freeform mode only) | `4` |
| `--mode <kind>` | Debate mode (choices: `freeform`, `structured`) | `freeform` |
| `--max-words <n>` | Soft per-response word cap | `250` |
| `--human <name>` | Add a human participant by name (repeatable) | `[]` |
| `--strategy <name>` | Moderator strategy for freeform mode (round-robin \| devils-advocate \| consensus-check). devils-advocate accepts an optional ":\<slug\>" suffix to pin the advocate (defaults to first expert). | `round-robin` |
| `--context-scope <scope>` | Visibility scope for prior turns: all \| same-round \| recent | `all` |
| `--summarize-after <n>` | Start rolling-summary after N rounds. Omit to disable. | — |
| `--heuristic-summaries` | Use simpler local summarizer instead of LLM — for offline/air-gapped use | — |
| `--heuristic-memory` | Skip post-debate LLM extraction — for offline/air-gapped use. Useful for offline tests and air-gapped environments. | — |
| `--yes` | Skip the auto-compose confirmation prompt — required for non-interactive / CI runs | — |
| `--verbose` | Show template migration notices and zero-change summaries | — |
| `-q, --quiet` | Suppress informational output | — |
| `--model <model>` | Model to use for experts (default: from config; run 'council doctor --models' to list available models) | — |
| `--max-experts <n>` | Maximum number of experts for auto-compose | — |
