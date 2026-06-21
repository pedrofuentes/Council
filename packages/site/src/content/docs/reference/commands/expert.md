---
title: "council expert"
description: "Manage Council's expert library (create, list, inspect, edit, delete)"
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Manage Council's expert library (create, list, inspect, edit, delete)

## Usage

```text
council expert [options] [command]
```

**Aliases:** `experts`

## Subcommands

### council expert create

Create a new expert in the library (or recreate one whose YAML was deleted)

**Usage**

```text
council expert create [options]
```

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--persona` | Create a trainable persona expert with document-based training via 'council expert train' | — |
| `--slug <slug>` | URL-safe slug (lowercase, alphanumeric + hyphens) | — |
| `--name <displayName>` | Display name | — |
| `--role <role>` | One-line role descriptor | — |
| `--expertise <items>` | Comma-separated weighted-evidence types (at least one) | — |
| `--stance <stance>` | Viewpoint or perspective (e.g., skeptical, optimistic, devil's advocate, conservative, neutral) | — |
| `--model <model>` | Model identifier (e.g. claude-haiku-4.5) | — |
| `--personality <flavor>` | Optional personality flavor | — |
| `--persona-description <text>` | Persona relationship description | — |

### council expert list

List all experts in the library

**Usage**

```text
council expert list [options]
```

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--format <kind>` | Output format: table (default) or json | `table` |

### council expert inspect

Show full detail for a single expert

**Usage**

```text
council expert inspect [options] <slug>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<slug>` | Expert slug to inspect | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--format <kind>` | Output format (plain or json) | `plain` |

### council expert edit

Open the expert YAML in $EDITOR and re-validate on save

**Usage**

```text
council expert edit [options] <slug>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<slug>` | Expert slug to edit | — |

### council expert delete

Delete an expert from the library

**Usage**

```text
council expert delete [options] <slug>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<slug>` | Expert slug to delete | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--force` | Delete even if the expert is a member of one or more panels | — |
| `--yes` | Skip confirmation prompt (required in non-interactive mode) | — |

### council expert docs

List or un-index documents for a persona expert

**Usage**

```text
council expert docs [options] <slug>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<slug>` | Persona expert slug | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--remove <file>` | Un-index the named document (kept on disk; profile refreshes on next use) | — |

### council expert train

Reprocess all documents for a persona expert and refresh its profile

**Usage**

```text
council expert train [options] <slug>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<slug>` | Persona expert slug | — |

**Options**

| Option | Description | Default |
| --- | --- | --- |
| `--retrain` | Clear the existing profile and rebuild from scratch | — |
| `--file <path...>` | Copy one or more files into the expert docs dir before training (repeatable) | — |
| `--url <url...>` | Download one or more URLs into the expert docs dir before training (repeatable); the URL's path must end in a supported file extension — .md, .txt, .html, .pdf, .csv, .docx, etc. — pages without a recognized extension won't be ingested | — |
| `--engine <kind>` | Engine to use for profile analysis (choices: `copilot`, `mock`, `openai`, `anthropic`) | `copilot` |
