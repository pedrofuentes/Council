---
title: "council docs"
description: "Document format reference and discoverability helpers"
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Document format reference and discoverability helpers

## Usage

```text
council docs [options] [command]
```

## Subcommands

### council docs formats

List supported document formats

**Usage**

```text
council docs formats [options]
```

### council docs review

Review files in a panel's docs corpus that couldn't be auto-processed

**Usage**

```text
council docs review [options] <panel>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<panel>` | Panel name | — |

### council docs extract

Run AI extraction on files a panel is holding for review (ask mode)

**Usage**

```text
council docs extract [options] <panel>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<panel>` | Panel name | — |

### council docs doctor

Diagnostic health check for a panel's document pipeline

**Usage**

```text
council docs doctor [options] <panel>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<panel>` | Panel name | — |
