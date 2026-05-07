# Changelog — Council

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project scaffolding: TypeScript ESM (Node 20+), tsup bundler, Vitest test runner, ESLint flat config v9 with typescript-eslint strict, Prettier formatter
- ESLint rule `no-restricted-imports` enforcing `@github/copilot-sdk` may only be imported from `src/engine/copilot/adapter.ts`
- CLI binary entry (`council --version`, `council --help`) using Commander.js
- Smoke test verifying Node 20+ runtime
- `src/engine/types.ts` — domain types (`ExpertSpec`, `SendOptions` with `AbortSignal`, `EngineResponse` (telemetry only — content is consumer-accumulated), `EngineError`, `EngineErrorCode`, `EngineEvent`, `ReasoningEffort`)
- `src/engine/index.ts` — `CouncilEngine` interface with documented cancellation contract (`AbortSignal`, iterator-return) and idempotency guarantees, the architectural seam between Council's domain logic and AI provider SDKs (per ADR-003)
- `src/engine/mock/mock-engine.ts` — `MockEngine` deterministic in-memory implementation of `CouncilEngine` for unit tests; covers full lifecycle (start/stop idempotency), expert registration, streaming success path, configured failures, and the cancellation contract (AbortSignal, stop(), removeExpert())
- `isRecoverable(code: EngineErrorCode): boolean` — single source of truth for retry semantics (closes issue #9). RATE_LIMITED and NETWORK are recoverable; all others are not.
- `pnpm check` script — chains `typecheck && lint && test` for a single pre-merge gate (partial fix for #13)

### Changed

### Fixed

### Removed
