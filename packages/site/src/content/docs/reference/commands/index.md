---
title: "Command Reference"
description: "Every Council CLI command, generated from the CLI's own Commander definitions."
---

> DO NOT EDIT — this file is auto-generated from the Council CLI's Commander definitions by `pnpm --filter @council-ai/site docs:generate:commands`. Run that command to regenerate it, and `pnpm --filter @council-ai/site docs:check:commands` to verify it is in sync.

Persistent AI expert panels for deliberation and decision-making

## Commands

| Command | Description |
| --- | --- |
| [`council doctor`](./doctor/) | Diagnose Council setup (Node, libsql, Copilot SDK, disk) |
| [`council demo`](./demo/) | Run a zero-setup, offline showcase debate (no login, keys, or network) to see Council in one command |
| [`council config`](./config/) | View and edit Council configuration |
| [`council telemetry`](./telemetry/) | Manage telemetry settings |
| [`council docs`](./docs/) | Document format reference and discoverability helpers |
| [`council update`](./update/) | Upgrade the globally-installed Council CLI to the latest version |
| [`council convene`](./convene/) | Run a panel debate on a topic and persist results to the local DB. |
| [`council resume`](./resume/) | Reopen a panel: show transcript, or continue with a new prompt |
| [`council conclude`](./conclude/) | Synthesize a panel's most substantive debate into a structured decision framework. |
| [`council review`](./review/) | Run the built-in code-review expert panel over a diff and print the review. |
| [`council ask`](./ask/) | Ask one expert from an existing panel a single question. |
| [`council chat`](./chat/) | Persistent conversation with an expert or panel from the library. |
| [`council expert`](./expert/) | Manage Council's expert library (create, list, inspect, edit, delete) |
| [`council panel`](./panel/) | Manage Council panels (create, list, inspect, edit, lint, delete) |
| [`council templates`](./templates/) | List built-in panel templates |
| [`council sessions`](./sessions/) | List debate sessions (past runs). |
| [`council memory`](./memory/) | Manage past debates and what experts remember |
| [`council export`](./export/) | Export a panel transcript to markdown, json, adr, or share format |
| [`council models`](./models/) | List available Copilot models (live discovery with static fallback) |

## Global options

| Option | Description | Default |
| --- | --- | --- |
| `-V, --version` | output the version number | — |
| `-q, --quiet` | Suppress informational stderr output | — |
