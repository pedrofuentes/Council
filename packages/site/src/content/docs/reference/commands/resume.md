---
title: "council resume"
description: "Reopen a panel: show transcript, or continue with a new prompt"
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Reopen a panel: show transcript, or continue with a new prompt

## Usage

```text
council resume [options] [panel]
```

## Arguments

| Argument | Description | Default |
| --- | --- | --- |
| `[panel]` | Panel name to resume (as shown by \`council sessions\`) | — |

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--format <kind>` | Output format (choices: `auto`, `json`, `plain`) | `auto` |
| `--prompt <prompt>` | Run a new debate against the same panel with this prompt | — |
| `--engine <kind>` | Engine for continue mode (choices: `mock`, `copilot`) | — |
| `--max-rounds <n>` | Max rounds for --prompt mode (default: 1) | — |
| `--max-words <n>` | Soft per-response word cap for --prompt mode | `250` |
| `--strategy <name>` | Moderator strategy for --prompt freeform mode (round-robin \| devils-advocate \| consensus-check). devils-advocate accepts an optional ":\<slug\>" suffix. | `round-robin` |
| `--heuristic-memory` | Skip post-debate LLM extraction — for offline/air-gapped use. Useful for offline tests and air-gapped environments. | — |
| `--latest` | Resume the most recent panel session | — |
