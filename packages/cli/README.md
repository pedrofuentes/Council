# 🏛️ @council-ai/cli

**Persistent AI expert panels that deliberate, disagree, and remember — in your terminal.**

[![npm version](https://img.shields.io/npm/v/@council-ai/cli?logo=npm)](https://www.npmjs.com/package/@council-ai/cli) [![npm downloads](https://img.shields.io/npm/dm/@council-ai/cli?logo=npm)](https://www.npmjs.com/package/@council-ai/cli) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Council convenes a panel of AI experts that debate a question from multiple
viewpoints, genuinely disagree, remember past deliberations, and produce a
structured synthesis. It runs on your **GitHub Copilot** subscription — no API
keys, no separate accounts, no credits to manage.

## Install

```bash
npm install -g @council-ai/cli
```

**Requirements:**

- Node.js 22+
- A GitHub Copilot subscription (Individual, Business, or Enterprise)

## Quick Start

```bash
# Verify your setup
council doctor

# Auto-compose an expert panel from the topic and run a debate
council convene "Should we build our own analytics platform or buy?"

# Use a built-in template instead of auto-composition
council convene "Review our auth middleware" --template code-review

# Run offline with the deterministic mock engine (testing/CI)
council convene "Test prompt" --template code-review --engine mock
```

On first run, Council auto-creates a default configuration and offers setup
guidance via `council doctor`.

The CLI implements `convene`, `ask`, `resume`, `conclude`, `export`, `sessions`,
`templates`, `expert`, `panel`, `chat`, `memory`, `doctor`, `docs`, and
`config`. Run `council --help` for the full command list.

## Documentation

Full documentation, examples, and the project roadmap live in the repository:

- **Repository**: <https://github.com/pedrofuentes/Council>
- **User guide**: [docs/GUIDE.md](https://github.com/pedrofuentes/Council/blob/main/docs/GUIDE.md)
- **Roadmap**: [ROADMAP.md](https://github.com/pedrofuentes/Council/blob/main/ROADMAP.md)

## License

MIT © Pedro Fuentes
