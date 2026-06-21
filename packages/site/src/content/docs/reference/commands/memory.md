---
title: "council memory"
description: "Manage past debates and what experts remember"
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Manage past debates and what experts remember

## Usage

```text
council memory [options] [command]
```

## Subcommands

### council memory list

List all panels with persisted state summary

**Usage**

```text
council memory list [options]
```

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--panel <name>` | Filter to a single panel | — |
| `--format <kind>` | Output format: plain (default) or json | `plain` |

### council memory inspect

Show detailed state for a single panel

**Usage**

```text
council memory inspect [options] <panel>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<panel>` | Panel name to inspect | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--expert <slug>` | Focus on a single expert by slug | — |
| `--format <kind>` | Output format: plain (default) or json | `plain` |

### council memory reset

Delete persisted state for a panel (destructive — requires --yes). Clears debate memory (debates, turns, extracted\_memory\_json) for the panel's experts. Document-derived persona profiles are preserved; use \`council expert train --retrain\` to reset a persona profile.

**Usage**

```text
council memory reset [options] <panel>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<panel>` | Panel name to reset | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--yes` | Confirm the destructive operation (REQUIRED — no interactive prompt) | — |
| `--hard` | Delete the entire panel (CASCADE removes experts + debates + turns) | — |
| `--expert <slug>` | Drop only this expert from the panel (keeps panel + others) | — |
