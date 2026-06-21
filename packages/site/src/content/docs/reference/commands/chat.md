---
title: "council chat"
description: "Persistent conversation with an expert or panel from the library."
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Persistent conversation with an expert or panel from the library. For structured debates use \`council convene\`.

## Usage

```text
council chat [options] [target]
```

## Arguments

| Argument | Description | Default |
| --- | --- | --- |
| `[target]` | Expert slug or panel name to chat with | — |

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--engine <kind>` | Engine to use (default: from config) (choices: `mock`, `copilot`) | — |
| `--new` | Archive the active conversation and start a fresh one | — |
| `--list` | List all chat conversations and exit | — |
| `--history` | Show archived conversations for the target | — |
