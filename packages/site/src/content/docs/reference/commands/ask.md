---
title: "council ask"
description: "Ask one expert from an existing panel a single question."
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Ask one expert from an existing panel a single question. For multi-expert debates use \`council convene\`. For conversation use \`council chat\`.

## Usage

```text
council ask [options] <panel> [question]
```

## Arguments

| Argument | Description | Default |
| --- | --- | --- |
| `<panel>` | Panel name from a previous debate (as shown by \`council sessions\`). For library experts, use \`council chat\`. | — |
| `[question]` | The question to ask (optional when --prompt-file is used) | — |

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--prompt-file <path>` | Read the question VERBATIM from a file (or \`-\` for stdin) instead of the positional argument. Bypasses the shell so \`$\`, backticks, and values like \`$180K\` survive intact. Mutually exclusive with the positional \<question\>. | — |
| `--engine <kind>` | Engine to use (default: from config) (choices: `copilot`, `mock`, `openai`, `anthropic`) | — |
| `--expert <slug>` | Expert slug to ask (default: first expert in the panel) | — |
| `--format <kind>` | Output format (choices: `auto`, `json`, `plain`) | `auto` |
| `--max-words <n>` | Soft per-response word cap | `250` |
