# Telemetry Specification

Council telemetry is opt-in, off by default, content-free, and trivially disabled. This document defines the only data that telemetry may collect if a future collection endpoint is enabled.

No outbound telemetry collection endpoint is enabled yet. This is a policy and data-shape specification only. Selecting a telemetry sink, vendor, transport, retention period, or operational process is a separate future decision.

## Status

- Default: disabled.
- User control: opt-in only, with an easy way to disable.
- Collection endpoint: none enabled.
- Content policy: command metadata only; no user content.

## Allowed fields

Telemetry events may contain only these fields:

| Field        | Description                                                    | Example                                 |
| ------------ | -------------------------------------------------------------- | --------------------------------------- |
| Command name | The Council command invoked, without arguments or content.     | `convene`, `ask`, `doctor`              |
| App version  | The Council application version.                               | `0.1.0`                                 |
| OS family    | A coarse operating-system family.                              | `darwin`, `linux`, `win32`              |
| Exit class   | A coarse result category, not a stack trace or detailed error. | `success`, `user_error`, `system_error` |

No other fields are allowed without updating this specification and obtaining maintainer sign-off.

## Forbidden fields

Telemetry must never include:

- prompts;
- completions or model responses;
- document contents;
- file paths;
- usernames;
- repository names;
- tokens;
- API keys;
- environment variable names or values;
- full configuration objects;
- SQLite database contents;
- chat transcripts;
- expert instructions;
- panel definitions;
- document indexes or extracted memory.

## Provider separation

Telemetry is separate from AI provider data flow. Prompts and other user-selected content may be sent to the configured AI provider so Council can perform the requested AI task, but that content is not telemetry and must not be copied into telemetry events.

## Implementation requirements

Any future telemetry implementation must:

1. keep telemetry disabled by default;
2. require explicit opt-in before sending any telemetry event;
3. provide a clear and simple disable path;
4. emit only the allowed fields listed above;
5. avoid logging, buffering, or persisting forbidden fields as part of telemetry handling;
6. avoid enabling an outbound endpoint without a separate reviewed decision.

This specification intentionally does not choose a sink, vendor, endpoint, or retention policy.
