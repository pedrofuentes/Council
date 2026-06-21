# Council Privacy Policy

Council is a local-first CLI for creating persistent AI expert panels. This policy describes what Council sends to AI providers, what it stores locally, how secrets are handled, and the telemetry constraints for this project.

This document is a maintainer-facing policy proposal. It is not a replacement for the terms, privacy notices, or data-processing commitments of any AI provider a user chooses to use with Council.

## AI provider data flow

Council sends user prompts, instructions, conversation context, and other user-selected content to the configured AI backend so the provider can generate responses.

- Today, Council uses GitHub Copilot as its AI provider integration.
- Council is provider-flexible. Direct OpenAI and Anthropic provider integrations are on the near-term roadmap and may be used when the user configures them.
- Each AI backend is a third-party service with its own terms, privacy policy, retention rules, abuse-monitoring practices, and enterprise controls.
- Users should not send content to Council that they are not permitted to send to the selected AI provider.

Council should frame provider behavior generically. It must not imply that data handling is Copilot-only, nor that future direct provider integrations inherit GitHub Copilot’s terms or controls.

## Local storage

Council stores local application data in a SQLite database under the Council home/data directory. The default location may be `~/Council` or `~/.council`, and it can be relocated with `COUNCIL_DATA_HOME`.

Local data may include:

- expert and panel definitions;
- chat sessions and transcripts;
- user-authored prompts and notes;
- document indexes and extracted document text or metadata;
- extracted memory or summaries used to support persistent expert behavior;
- local configuration that is safe to persist.

Because transcripts, document indexes, and extracted memory may contain user-authored or user-provided content, users should treat the Council data directory as sensitive application data. Backups, sync tools, disk encryption, and filesystem permissions are controlled by the user’s environment, not by Council.

## Secrets

Council must never store secrets in SQLite.

Provider API keys, tokens, and similar credentials must be read from environment variables or an equivalent external credential source when a provider integration requires them. Council must not persist provider API keys, tokens, or secret environment values in its database, transcripts, telemetry, reports, or configuration files.

Users should avoid putting secrets in prompts, documents, panel descriptions, expert instructions, or other content that Council may store locally or send to the selected AI provider.

## Telemetry

Council telemetry is opt-in and off by default. Telemetry must be content-free and easy to disable.

When telemetry is enabled, the allowed event fields are limited to command name, app version, operating-system family, and exit class. Telemetry must not include prompts, completions, document contents, file paths, usernames, repository names, tokens, API keys, environment values, full configuration, or SQLite contents.

No outbound telemetry collection endpoint is enabled yet. The telemetry policy and specification define the allowed shape of future telemetry only; choosing, configuring, or operating a collection sink is a separate future decision.

See [`docs/TELEMETRY.md`](docs/TELEMETRY.md) for the telemetry specification.
