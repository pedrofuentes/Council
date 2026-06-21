---
title: "council panel"
description: "Manage Council panels (create, list, inspect, edit, delete)"
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Manage Council panels (create, list, inspect, edit, delete)

## Usage

```text
council panel [options] [command]
```

**Aliases:** `panels`

## Subcommands

### council panel create

Create a new panel with library experts. If \`council convene\` runs without \`--template\`, Council auto-composes a panel for you.

**Usage**

```text
council panel create [options] [name]
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `[name]` | Panel name (kebab-case). Alias: --slug | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--slug <slug>` | Panel name (kebab-case). Alias for the positional \<name\> argument. | — |
| `--experts <slugs...>` | Expert slugs from the library (space- or comma-separated, repeatable) | — |
| `--mode <mode>` | Debate mode: freeform \| structured | — |
| `--max-rounds <n>` | Maximum debate rounds (1-20) | — |
| `--model <model>` | Default model for all experts in this panel | — |
| `--description <text>` | One-line description | — |

### council panel save

Promote a debate session (e.g. an auto-composed \`convene\` run) into a reusable library panel + experts.

**Usage**

```text
council panel save [options] [session] [name]
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `[session]` | Session name or unique prefix to promote (omit when using --latest) | — |
| `[name]` | Name for the new library panel (kebab-case). Defaults to the panel's composed name. | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--latest` | Promote the most recently active session instead of naming one | — |

### council panel list

List user panels in the library

**Usage**

```text
council panel list [options]
```

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--format <kind>` | Output format: table (default) or json | `table` |
| `--long` | Show full descriptions without truncation | — |

### council panel inspect

Show full detail for a single panel

**Usage**

```text
council panel inspect [options] <name>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<name>` | Panel name to inspect | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--format <kind>` | Output format (plain or json) | `plain` |

### council panel edit

Open the panel YAML in $EDITOR and re-validate on save

**Usage**

```text
council panel edit [options] <name>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<name>` | Panel name to edit | — |

### council panel delete

Removes the panel template (library record, members, documents, YAML, and docs directory). Debate sessions created with this panel are preserved and remain accessible via 'council sessions'.

**Usage**

```text
council panel delete [options] <name>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<name>` | Panel name to delete | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--yes` | Skip the confirmation prompt (non-interactive runs) | — |

### council panel docs

Manage panel reference documents (list, link, unlink)

**Usage**

```text
council panel docs [options] [command] [name]
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `[name]` | Panel name (when omitted, prints usage) | — |

#### council panel docs list

List all documents accessible to a panel (managed + linked)

**Usage**

```text
council panel docs list [options] <name>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<name>` | Panel name | — |

#### council panel docs link

Link an external folder for RAG retrieval

**Usage**

```text
council panel docs link [options] <name>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<name>` | Panel name | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--path <path>` | Absolute path to the folder to link | — |
| `--yes` | Skip the confirmation prompt (non-interactive runs) | — |

#### council panel docs unlink

Remove a linked folder and un-index its documents

**Usage**

```text
council panel docs unlink [options] <name>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<name>` | Panel name | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--path <path>` | Folder path previously linked | — |
