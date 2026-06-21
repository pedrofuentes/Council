---
title: "council conclude"
description: "Synthesize a panel's most substantive debate into a structured decision framework."
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Synthesize a panel's most substantive debate into a structured decision framework. For transcript-based ADR (Architecture Decision Record) export, use \`council export --format adr\` instead.

## Usage

```text
council conclude [options] [panel]
```

## Arguments

| Argument | Description | Default |
| --- | --- | --- |
| `[panel]` | Panel name to conclude (defaults to the most recently created panel) | — |

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--engine <kind>` | Engine kind (default: from config) (choices: `copilot`, `mock`, `openai`, `anthropic`) | — |
| `--format <kind>` | Output format (choices: `plain`, `json`) | `plain` |
| `--timeout <ms>` | Synthesis timeout in milliseconds | `60000` |
| `--model <model>` | Model to use for synthesis (default: from config) | — |
