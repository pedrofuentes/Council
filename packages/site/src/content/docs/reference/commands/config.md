---
title: "council config"
description: "View and edit Council configuration"
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

View and edit Council configuration

## Usage

```text
council config [options] [command]
```

## Subcommands

### council config show

Print effective config values with source annotation

**Usage**

```text
council config show [options]
```

### council config path

Print the config file path (useful for scripts)

**Usage**

```text
council config path [options]
```

### council config edit

Open the config file in $EDITOR and validate on save

**Usage**

```text
council config edit [options]
```

### council config set

Set a supported config value

**Usage**

```text
council config set [options] <key> <value>
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `<key>` | Dot-notation config key | — |
| `<value>` | Value to write | — |

### council config model

Set the default AI model — pass \<name\>, or omit it on a terminal for an interactive picker

**Usage**

```text
council config model [options] [name]
```

**Arguments**

| Argument | Description | Default |
| --- | --- | --- |
| `[name]` | Model id to set (omit on a TTY to pick interactively) | — |

### council config wizard

Guided interactive setup for common config values

**Usage**

```text
council config wizard [options]
```
