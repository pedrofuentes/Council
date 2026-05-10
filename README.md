# 🏛️ Council

**Persistent AI expert panels that deliberate, disagree, and remember.**

> Like having a board of advisors in your terminal — with memory, genuine disagreement, and structured synthesis.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 30-Second Demo

<!-- TODO: Add terminal recording (VHS/asciinema) -->

```bash
$ council convene "Should we migrate from monolith to microservices?"

🏛️ Panel assembled: 3 experts
  • Dahlia Renner (CTO) — claude-sonnet-4
  • Marcus Chen (PM) — gpt-5
  • The Adversary — claude-sonnet-4

━━━ Round 1 ━━━

[Dahlia Renner — CTO]
Your team is 18 engineers. Every microservices migration I've seen at this
scale has the same failure mode: you split before you can operate...

[Marcus Chen — PM]
I disagree with Dahlia's framing. The question isn't team size — it's
time-to-learning. A monolith means every experiment touches everything...

[The Adversary]
Both of you are assuming the migration is binary. The real question neither
has addressed: what specific coupling in your monolith is actually blocking
you today?

━━━ Synthesis ━━━
The panel disagrees on timing but agrees on one thing: identify the specific
pain points before choosing an architecture...
```

## Why Council?

ChatGPT gives you **one perspective**. Council gives you **structured deliberation** from multiple expert viewpoints — with memory, disagreement, and synthesis.

| You ask... | Single AI says... | Council deliberates... |
|-----------|------------------|----------------------|
| "Should we use microservices?" | Generic pros/cons list | CTO argues operational risk, PM argues time-to-learning, Adversary challenges both — then synthesis names the crux |
| "Review this auth middleware" | Unified feedback | Security auditor flags JWT expiry, performance engineer finds N+1, future maintainer asks "will I understand this in 6 months?" |
| "Should I take the manager role?" | Balanced advice | IC mentor argues stay, manager argues switch, career coach provides a decision framework |

## Install

```bash
npm install -g @council/cli
```

**Requirements:**
- Node.js 20+
- GitHub Copilot subscription (Individual, Business, or Enterprise)
- No API keys. No OpenAI account. No credits to manage.

## Quick Start

> 🚧 **Phase 1 in progress.** The CLI implements `convene`, `resume`, `export`, `panels`, `templates`, and `doctor` today. `ask` and `conclude` are next (see [ROADMAP.md](./ROADMAP.md)).

```bash
# Verify your setup
council doctor

# Run a panel debate against the real Copilot SDK
council convene "Should we rewrite our billing system?" \
  --template code-review --engine copilot --max-rounds 4

# Or run offline with the deterministic mock engine (for testing/CI)
council convene "Test prompt" --template code-review --engine mock

# Use structured 4-phase choreography (opening → cross-exam → rebuttal → synthesis)
council convene "Should we ship the MVP?" --template architecture-review \
  --engine copilot --mode structured

# Pipe NDJSON output to jq, logs, or scripts
council convene "..." --template code-review --engine copilot --format json | jq .

# Show the transcript of a previous debate
council resume <panel-name>

# Continue a previous panel with a new prompt
council resume <panel-name> --continue "What about the migration risk?" --engine copilot

# Export a panel transcript for sharing
council export <panel-name>                         # markdown (default)
council export <panel-name> --format adr            # Architecture Decision Record
council export <panel-name> --format json --output transcript.ndjson
```

## Built-in Panels

| Panel | Experts | Best For |
|-------|---------|----------|
| `architecture-review` | CTO, Staff Engineer, SRE, Product Manager | Technical architecture decisions |
| `startup-validation` | VC Partner, Target Customer, Competitor, Distribution Expert | Idea validation |
| `code-review` | Senior Dev, Security Auditor, Performance Engineer, Future Maintainer | Code quality |
| `incident-postmortem` | SRE, Engineering Manager, Customer Advocate, Blameless Facilitator | Blameless analysis |
| `career-coaching` | IC Mentor, Engineering Manager, VP Eng, Career Coach | Career decisions |

```bash
council convene --template architecture-review "Should we adopt GraphQL?"
```

## Create Custom Panels

```yaml
# panels/my-team.yaml
name: product-strategy
description: "Evaluate product decisions"
experts:
  - slug: pm
    displayName: "Product Manager"
    role: "User-value-focused PM who references metrics"
    expertise:
      weightedEvidence:
        - "User research and behavioral data"
        - "Market positioning and competitive analysis"
        - "Revenue impact and unit economics"
      referenceCases:
        - "Feature factories: shipping features without measuring impact"
      notExpertIn: ["infrastructure", "security"]
    epistemicStance: >
      You've been burned by engineering-led products that nobody used.
      You trust user data over architectural elegance.

  - slug: engineer
    displayName: "Staff Engineer"
    role: "Systems thinker focused on long-term maintainability"
    # ...
```

## How It Works

1. **Panels** are groups of AI experts with distinct roles, perspectives, and expertise priors
2. **Deliberation** happens in rounds — experts respond, challenge each other, and build on disagreements
3. **Memory** persists across sessions — your panel remembers previous discussions
4. **Synthesis** produces actionable output with areas of agreement and unresolved tensions

### What Makes Council Different

- **Expertise as prior, not persona** — Experts have distinct *objective functions*, not just different labels. Disagreement emerges naturally from weighing evidence differently.
- **Anti-sycophancy by design** — 3-layer system prevents experts from agreeing with each other reflexively: forbidden phrases, mandatory disagreement budget, identity stakes.
- **Persistent memory** — Experts remember past positions, updated priors, and unresolved questions across sessions.
- **CLI-native** — Built for developer workflows. Pipe-friendly (`--format json`), scriptable, CI-compatible.
- **Zero key management** — Uses GitHub Copilot SDK. One auth, all models (GPT, Claude, Gemini).

## Commands

```bash
council convene <topic>          # Create panel + start deliberation
council convene --template <name>  # Use a built-in panel
council ask <question>           # Continue with the full panel
council ask --expert <slug> <q>  # Talk to one expert directly
council conclude                 # Get decision matrix + recommendation
council panels                   # List all panels
council resume                   # Resume a previous panel
council export --format <fmt>    # Export (markdown | json | adr)
council memory list              # Show what experts remember
council doctor                   # Diagnose setup issues
council config                   # View/set configuration
```

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the detailed implementation plan.

**Current phase:** Foundation (Phase 1) — building core engine, expert system, and CLI.

## Contributing

We welcome contributions! The easiest way to start: **create a panel template** (YAML file in `panels/`) and submit a PR.

See [docs/DEVELOPMENT-WORKFLOW.md](./docs/DEVELOPMENT-WORKFLOW.md) for development setup.

## License

MIT © Pedro Fuentes
