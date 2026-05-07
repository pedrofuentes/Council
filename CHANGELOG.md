# Changelog — Council

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project scaffolding: TypeScript ESM (Node 20+), tsup bundler, Vitest test runner, ESLint flat config v9 with typescript-eslint strict, Prettier formatter
- ESLint rule `no-restricted-imports` enforcing `@github/copilot-sdk` may only be imported from `src/engine/copilot/**`
- CLI binary entry (`council --version`, `council --help`) using Commander.js
- Smoke test verifying Node 20+ runtime

### Changed

### Fixed

### Removed
