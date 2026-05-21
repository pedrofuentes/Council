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

| You ask...                        | Single AI says...      | Council deliberates...                                                                                                          |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| "Should we use microservices?"    | Generic pros/cons list | CTO argues operational risk, PM argues time-to-learning, Adversary challenges both — then synthesis names the crux              |
| "Review this auth middleware"     | Unified feedback       | Security auditor flags JWT expiry, performance engineer finds N+1, future maintainer asks "will I understand this in 6 months?" |
| "Should I take the manager role?" | Balanced advice        | IC mentor argues stay, manager argues switch, career coach provides a decision framework                                        |

## Install

```bash
npm install -g @council/cli
```

**Requirements:**

- Node.js 20+
- GitHub Copilot subscription (Individual, Business, or Enterprise)
- No API keys. No OpenAI account. No credits to manage.

## Quick Start

> **Phases 1–7 complete.** The CLI implements `convene`, `ask`, `resume`, `conclude`, `export`, `sessions`, `templates`, `expert`, `panel`, `chat`, `memory`, and `doctor`. See [ROADMAP.md](./ROADMAP.md) for Phase 8 (Growth & Ecosystem) plans.

```bash
# Verify your setup
council doctor

# Auto-compose a panel from the topic (no --template needed — Council
# designs an expert panel for you using a meta-prompt)
council convene "Should we go public?" --engine copilot

# Run a panel debate against the real Copilot SDK (with an explicit template)
council convene "Should we rewrite our billing system?" \
  --template code-review --engine copilot --max-rounds 4

# Or run offline with the deterministic mock engine (for testing/CI)
council convene "Test prompt" --template code-review --engine mock

# Use structured 4-phase choreography (opening → cross-exam → rebuttal → synthesis)
council convene "Should we ship the MVP?" --template architecture-review \
  --engine copilot --mode structured

# Choose a moderator strategy for freeform debates (default: round-robin)
council convene "Ship now or wait?" --template code-review --engine copilot \
  --strategy consensus-check
council convene "Ship now or wait?" --template code-review --engine copilot \
  --strategy devils-advocate:senior   # pin "senior" as the contrarian

# Tame long debates with context-window management (§2.6)
council convene "Long architectural debate" --template architecture-review \
  --engine copilot --max-rounds 10 \
  --context-scope recent          # only the most-recent turns are passed forward
council convene "Long debate" --template architecture-review \
  --engine copilot --max-rounds 10 \
  --context-scope same-round      # each expert only sees its round-mates
council convene "Long debate" --template architecture-review \
  --engine copilot --max-rounds 10 \
  --summarize-after 3             # prepend a rolling summary after round 3

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

# Inspect what's persisted locally
council memory list                                 # summary of all panels
council memory inspect <panel-name>                 # detail view
council memory inspect <panel-name> --expert cto    # single-expert detail (includes provenance: source debate, trust score)

# Curate (destructive — requires --yes)
council memory reset <panel-name> --yes             # clear debates+turns, keep panel+experts
council memory reset <panel-name> --hard --yes      # delete the panel entirely

# Manage the expert library (~/Council/experts/*.yaml)
council expert create                               # interactive wizard
council expert create --persona                     # persona expert (creates docs/ folder)
council expert list                                 # table view (also --format json)
council expert inspect <slug>                       # full detail + panel memberships
council expert edit <slug>                          # open YAML in $EDITOR, re-validate on save
council expert delete <slug>                        # refuses if in any panel (use --force to override)

# Chat 1:1 with a persona expert — drop reference docs in
# ~/Council/experts/<slug>/docs/ (any combination of .md / .txt / .html).
# On every `council chat <slug>` invocation, Council auto-detects new,
# changed, or deleted documents, re-extracts and re-indexes them
# (deletions prune the FTS index and mark the DB row as removed),
# refreshes the persona profile, and only THEN registers the expert —
# so the next reply already reflects the latest reference material.
# Files outside the docs folder (e.g. symlinks pointing elsewhere) are
# rejected for safety; the docs folder itself must be a real directory
# (symlinks/junctions as the root are also rejected). An empty docs
# folder is fine: the persona just runs as a generic expert.
council chat <persona-slug>                         # auto-processes ~/Council/experts/<slug>/docs/

# Manage a panel's shared document corpus (Roadmap 6.7) — drop reference
# material into the auto-provisioned ~/Council/panels/<name>/docs/ folder
# OR link an external folder. On `council chat <panel>`, the scanner
# walks every managed + linked folder, indexes new/changed files into
# the FTS5 corpus under source_type='panel', and prunes any tracked
# documents that have disappeared from disk.
council panel docs <name>                                  # list managed + linked folders + doc counts
council panel docs link <name> --path <folder>             # link an external folder (symlinks rejected)
council panel docs unlink <name> --path <folder>           # remove a linked folder + its FTS entries
```

## Persona Experts & Document Intelligence

A **persona expert** is one whose voice is shaped by a corpus of reference
documents (CVs, design docs, RFCs, prior emails, transcripts). Create one
with `council expert create --persona --slug <slug>` — Council provisions
`~/Council/experts/<slug>/docs/` and the expert is registered with
`kind: "persona"`.

**On every `council chat <persona-slug>` invocation** (Roadmap 6.1, 6.2,
6.4, 6.8):

1. **Detect** new, modified, and deleted files by SHA-256 checksum
   against the `expert_documents` table (migration 006).
2. **Extract** content from `.md`, `.txt`, and `.html` files (regex-based
   normalisation — see ADR-009) using a TOCTOU-safe fd-bound read that
   verifies inode equality and confines reads to the docs root.
3. **Index** the normalised text into FTS5 (`document_index`,
   migration 007) for retrieval-augmented prompts.
4. **Analyze** the corpus into a structured `PersonaProfile`
   (`communicationStyle`, `decisionPatterns`, `biases`, `vocabulary`,
   `epistemicStance`) via a transient LLM "Profile Analyzer" expert. The
   profile is persisted to `persona_profiles` (migration 008) and
   injected into the expert's system prompt as `[N] PERSONA PROFILE` so
   the very next reply already reflects the latest material.

**Recency weighting** — each document block in the analyzer meta-prompt
is annotated with a `[Weight: 0.NN]` tag computed via exponential decay
(`weight = 2^(-ageDays / halfLifeDays)`, default half-life = 90 days).
The LLM is instructed to weight more-recent material more heavily, so
an updated CV or revised RFC takes priority over older versions without
you having to delete the predecessors. The analyzer preserves the
caller's input order — weight tags reflect age regardless of how
documents were enumerated.

**Reset behaviour** — `council memory reset <panel>` clears debate
transcripts, extracted memory, and provenance metadata but **preserves persona profiles**
(Roadmap 7.4): rebuilding a profile costs an LLM call, and the profile
is derived from on-disk documents that survive the reset anyway.

**Security** — the docs folder must be a real directory (symlinks /
junctions as the root are rejected up front); per-file confinement uses
a once-resolved canonical root passed through both the detector and the
extractor (closing root-swap TOCTOU windows). Profile fields and
document content are sanitised through layered defenses before reaching
the privileged system prompt — see ADR-008.

Generic experts (`kind` unset or `"generic"`) skip the entire pipeline
and behave exactly as before — `personaProfile` arguments to
`buildSystemPrompt()` are ignored unless the expert is a persona
(Roadmap 7.1).

## Built-in Panels

| Panel                 | Experts                                                               | Best For                         |
| --------------------- | --------------------------------------------------------------------- | -------------------------------- |
| `architecture-review` | CTO, Staff Engineer, SRE, Product Manager                             | Technical architecture decisions |
| `startup-validation`  | VC Partner, Target Customer, Competitor, Distribution Expert          | Idea validation                  |
| `code-review`         | Senior Dev, Security Auditor, Performance Engineer, Future Maintainer | Code quality                     |
| `incident-postmortem` | SRE, Engineering Manager, Customer Advocate, Blameless Facilitator    | Blameless analysis               |
| `career-coaching`     | IC Mentor, Engineering Manager, VP Eng, Career Coach                  | Career decisions                 |

```bash
council convene --template architecture-review "Should we adopt GraphQL?"
```

> **Migration note**: On first use of `--template` after upgrading, Council auto-migrates built-in panels to the library format — extracting experts into `~/Council/experts/` and rewriting panels to use slug references. Migration **never overwrites existing files**: if you've already created `~/Council/experts/cto.yaml` with a custom definition, the migration skips it and your panel references your custom expert instead of the built-in one. To reset to built-in defaults, delete the expert YAML and re-run.

## Create Custom Panels

User panels live in `<dataHome>/panels/<name>.yaml` (default `~/Council/panels/`)
and take precedence over Council's built-in templates of the same name.
Each `experts` entry is **either** an inline definition **or** a slug
string referencing an expert in your library (see `council experts ...`).

```yaml
# ~/Council/panels/my-team.yaml
name: product-strategy
description: "Evaluate product decisions"
experts:
  # Reference a reusable library expert by slug:
  - pm-veteran
  # Or define one inline for this panel only:
  - slug: engineer
    displayName: "Staff Engineer"
    role: "Systems thinker focused on long-term maintainability"
    expertise:
      weightedEvidence:
        - "Distributed systems design"
        - "Production incident postmortems"
      referenceCases:
        - "Microservices sprawl: more services than engineers"
      notExpertIn: ["product-market fit", "pricing"]
    epistemicStance: >
      You've debugged enough on-call pages to distrust shiny abstractions.
      You optimise for the team that maintains this in two years.
```

Run with `council convene "<topic>" --template my-team`. Slug references
are resolved against your expert library; unresolved slugs produce an
explicit error so you can either add them with `council expert create`
or inline the definition.

### First-run template migration

On the first `council convene --template <name>` after upgrade, Council
extracts the inline experts from the built-in panels
(`architecture-review`, `career-coaching`, `code-review`,
`incident-postmortem`, `startup-validation`) into
`~/Council/experts/<slug>.yaml` and rewrites the panels into
`~/Council/panels/<name>.yaml` referencing those experts by slug. This
makes the stock experts editable (with `council expert edit <slug>`)
and reusable from your own panels. Migration is **non-destructive**
(existing user files are never overwritten) and **idempotent** — it
short-circuits on subsequent runs and re-registers library DB rows from
disk if the database is reset.

## How It Works

1. **Panels** are groups of AI experts with distinct roles, perspectives, and expertise priors
2. **Deliberation** happens in rounds — experts respond, challenge each other, and build on disagreements
3. **Memory** persists across sessions — your panel remembers previous discussions
4. **Synthesis** produces actionable output with areas of agreement and unresolved tensions

### What Makes Council Different

- **Expertise as prior, not persona** — Experts have distinct _objective functions_, not just different labels. Disagreement emerges naturally from weighing evidence differently.
- **Anti-sycophancy by design** — 3-layer system prevents experts from agreeing with each other reflexively: forbidden phrases, mandatory disagreement budget, identity stakes.
- **Persistent memory** — Experts remember past positions, updated priors, and unresolved questions across sessions. By default, an LLM extraction pass runs at the end of each debate and persists structured memory per expert; the next debate recalls that distilled context instead of a heuristic scan. Pass `--heuristic-memory` to convene/resume to opt out (e.g. for offline or air-gapped runs).
- **CLI-native** — Built for developer workflows. Pipe-friendly (`--format json`), scriptable, CI-compatible.
- **Zero key management** — Uses GitHub Copilot SDK. One auth, all models (GPT, Claude, Gemini).

## Commands

```bash
# Debate orchestration (most run a real engine — pass --engine copilot or --engine mock)
council convene <topic> --engine copilot                       # Auto-compose a panel + start deliberation
council convene <topic> --template <name> --engine copilot     # Use a built-in or library panel
council ask <panel> "<question>" --engine copilot              # One-shot to one expert (default: first; pin with --expert <slug>)
council conclude [panel] --engine copilot                      # Decision matrix + recommendation
council resume <panel>                                          # Replay transcript (no engine needed)
council resume <panel> --continue "<prompt>" --engine copilot  # Continue the panel with a new round
council export <panel> --format <fmt>                          # Export (markdown | json | adr)

# Safety: every entry point (convene, ask, chat, in-REPL @convene) runs a warn-only
# topic-admission check first — sensitive topics emit "⚠ This topic touches sensitive
# areas (…)" but are never blocked.

# Persistent conversational chat (Phase 5) — interactive sessions require --engine
council chat <expert-slug> --engine copilot      # 1:1 conversational REPL with an expert
council chat <panel-name> --engine copilot       # Group chat with a panel (supports @mentions, @convene)
council chat <target> --new --engine copilot     # Archive active session and start fresh
council chat --list                              # List every chat session across all targets (no engine needed)
council chat <target> --history                  # Show archived sessions read-only (no engine needed)

# Expert library (Phase 4)
council expert create [--persona]           # Interactive wizard (or non-TTY via flags)
council expert list [--format json]         # Browse the expert library
council expert inspect <slug>               # Full detail + panel memberships
council expert edit <slug>                  # Open YAML in $EDITOR; re-validates on save
council expert delete <slug> [--force]      # Refuses if expert is in any panel
council expert docs <slug>                  # Manage a persona expert's reference-docs folder
council expert train <slug> [--retrain]     # (Re-)run the persona profile analyzer

# Panel library (Phase 4)
council panel create <name>                 # Interactive wizard: pick experts, set description + mode
council panel list [--format json]          # Browse panels in the library
council panel inspect <name>                # Panel metadata + resolved expert roster
council panel edit <name>                   # Open YAML in $EDITOR; re-validates on save
council panel docs <name>                   # List a panel's managed + linked doc folders
council panel docs link <name> --path <p>   # Link an external folder into a panel's RAG corpus
council panel docs unlink <name> --path <p> # Unlink a folder + clean up its FTS entries

# Inspection & diagnostics
council sessions                            # List all debate sessions
council templates                           # List built-in panel templates
council memory list                         # Show what experts remember
council memory inspect <panel>              # Per-panel + per-expert memory detail
council memory reset <panel> --yes          # Destructive: clear debate state
council doctor                              # Diagnose setup issues
```

> Configuration lives in `~/.council/config.yaml` (auto-created on first run).
> Edit it directly — there is no dedicated `council config` subcommand.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the high-level plan and [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md) for implementation details.

**Current focus:** Phase 8 — Growth & Ecosystem (`gh` extension, GitHub Action, direct provider APIs, npm publish).

## Contributing

We welcome contributions! The easiest way to start: **create a panel template** (YAML file in `panels/`) and submit a PR.

See [docs/DEVELOPMENT-WORKFLOW.md](./docs/DEVELOPMENT-WORKFLOW.md) for development setup.

## License

MIT © Pedro Fuentes
