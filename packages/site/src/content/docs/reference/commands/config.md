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
