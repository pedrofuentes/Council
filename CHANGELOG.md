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
- `src/config/schema.ts` — Zod-based `ConfigSchema`, `CouncilConfig` type, `DEFAULT_MODEL` constant. Conservative defaults (3 experts, 4 rounds, 250-word cap)
- `src/config/loader.ts` — `loadConfig()` (reads YAML, applies defaults, writes default file when missing) and `getCouncilHome()` (honors `COUNCIL_HOME` env var for tests + ephemeral mode)
- New runtime deps: `zod`, `yaml`
- `src/core/expert.ts` — `ExpertDefinitionSchema` (Zod) for static expert profiles; validated by panel YAML loader and ad-hoc CLI definitions alike
- `src/core/prompt-builder.ts` — `buildSystemPrompt(def, memory, task)` produces the full 8-section prompt (IDENTITY → EXPERTISE PRIOR → EPISTEMIC STANCE → DEBATE PROTOCOL → OUTPUT CONTRACT → FORBIDDEN MOVES → MEMORY → CURRENT TASK). Anti-sycophancy defaults (`DEFAULT_FORBIDDEN_PHRASES`, `DEFAULT_DEBATE_PROTOCOL`, `DEFAULT_OUTPUT_CONTRACT`) are always injected; profiles may supplement but cannot remove them.
- `ExpertMemory` type — positions, updatedPriors, unresolved questions; injected as terse bulleted log into section [7]
- `src/core/template-loader.ts` — `PanelDefinitionSchema` (Zod with duplicate-slug check), `loadTemplate(name)`, `loadTemplateFromFile(path)`, `listTemplates()`
- `panels/architecture-review.yaml` — CTO, Staff Engineer, SRE Lead, Product Manager
- `panels/startup-validation.yaml` — VC Partner, Target Customer, Existing Competitor, Distribution Expert
- `panels/code-review.yaml` — Senior Developer, Security Auditor, Performance Engineer, Future Maintainer
- `panels/incident-postmortem.yaml` — SRE Lead, Engineering Manager, Customer Advocate, Blameless Facilitator
- `panels/career-coaching.yaml` — IC Mentor, Engineering Manager (was IC), VP Engineering, Career Coach
- `src/core/quality-gate.ts` — heuristic anti-sycophancy quality gate. Inspects expert responses against the 3-layer system (forbidden phrases, disagreement budget when prior speakers exist, minimum specificity) and produces a `regenerateHint` for the orchestrator to pass back on the next attempt.

### Changed

### Fixed

### Removed
