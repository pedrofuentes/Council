---
title: "council export"
description: "Export a panel transcript to markdown, json, adr, or share format"
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Export a panel transcript to markdown, json, adr, or share format

## Usage

```text
council export [options] <panel>
```

## Arguments

| Argument | Description | Default |
| --- | --- | --- |
| `<panel>` | Panel name to export (as shown by \`council sessions\`) | — |

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--format <kind>` | Output format (choices: `markdown`, `json`, `adr`, `share`) | `markdown` |
| `--output <path>` | Write to file instead of stdout (default: stdout) | — |
