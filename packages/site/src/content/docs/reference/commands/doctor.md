---
title: "council doctor"
description: "Diagnose Council setup (Node, libsql, Copilot SDK, disk)"
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Diagnose Council setup (Node, libsql, Copilot SDK, disk)

## Usage

```text
council doctor [options]
```

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--online` | No-op; online check now runs by default (backwards compatibility) | — |
| `--offline` | Skip online model probe | — |
| `--models` | List available Copilot models (live discovery with static fallback) | — |
| `--report <format>` | Emit a sanitized diagnostic report for bug reports (json\|markdown) | — |
