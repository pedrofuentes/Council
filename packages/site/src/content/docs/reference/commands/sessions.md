---
title: "council sessions"
description: "List debate sessions (past runs)."
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

List debate sessions (past runs). For panel templates, use \`council panel list\`.

## Usage

```text
council sessions [options] [command]
```

**Aliases:** `history`

## Options

| Option | Description | Default |
| --- | --- | --- |
| `--format <kind>` | Output format: json (NDJSON) or plain (human-readable) | `plain` |

## Subcommands

### council sessions cancel

Mark stale running debates as interrupted

**Usage**

```text
council sessions cancel [options] [name]
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `[name]` | Panel name to cancel (supports unique prefix matching) | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--all` | Cancel all running debates | — |

### council sessions delete

Delete a completed or interrupted session

**Usage**

```text
council sessions delete [options] <name>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<name>` | Session name to delete (supports unique prefix matching) | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--yes` | Skip confirmation prompt | — |
