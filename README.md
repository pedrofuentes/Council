# 🏛️ Council

**Structured multi-expert deliberation in your terminal — with memory, genuine disagreement, and no sycophancy.**

Stop getting single-perspective advice from AI. Council creates persistent expert panels that deliberate, disagree, and remember across sessions — so you get deeper insights for complex decisions.

[![npm version](https://img.shields.io/npm/v/@council-ai/cli?logo=npm)](https://www.npmjs.com/package/@council-ai/cli) [![npm downloads](https://img.shields.io/npm/dm/@council-ai/cli?logo=npm)](https://www.npmjs.com/package/@council-ai/cli) [![CI](https://github.com/pedrofuentes/Council/actions/workflows/ci.yml/badge.svg)](https://github.com/pedrofuentes/Council/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![npm provenance](https://img.shields.io/badge/npm-provenance-cb3837?logo=npm)](https://docs.npmjs.com/generating-provenance-statements)

**Provider-flexible:** Runs on GitHub Copilot today. OpenAI and Anthropic support planned ([see roadmap](./ROADMAP.md#phase-8-growth--ecosystem)).

---

## Quick Start

```bash
# Install
npm install -g @council-ai/cli

# Verify setup (checks Node.js, SQLite, Copilot SDK, disk)
council doctor

# Run your first deliberation — Council auto-composes an expert panel for you
council convene "Should we build our own analytics or buy a vendor solution?"
```

Because the example above passed no `--template`, Council **auto-composes** a
panel for your topic, prints the proposed roster, and asks you to confirm
(`Proceed with this panel? [y/N]`) before the debate starts. Add `--yes` to skip
the prompt in non-interactive or scripted runs — a non-interactive shell (piped
input or CI) _requires_ `--yes` and otherwise exits with an error rather than
hanging. Pass `--template <name>` to use a built-in panel and bypass
auto-composition (and its confirmation prompt) entirely.

When a debate completes, `council convene` automatically generates a final
structured conclusion by default. This costs one additional premium synthesis
request; pass `--no-conclude` to save the request and skip the conclusion.

**Requirements:** Node.js 24+, GitHub Copilot subscription (Individual, Business, or Enterprise). No API keys, no credits to manage.

### First run: choosing a default model

The first time you run a command that needs a model (for example
`council convene`), Council performs a one-time setup: it discovers the models
available to your Copilot subscription, recommends one (`claude-sonnet-4.5`), and
asks you to choose a default. Your selection is saved to config as
`defaults.model`, so the wizard runs only once.

- **Non-interactive shells** (piped input or CI) skip the prompt and
  automatically use the recommended model, printing
  `Non-interactive session detected; using recommended model <id>`.
- **If live model discovery fails**, Council falls back to a built-in static
  list and warns `Live model discovery failed, so Council is showing a built-in
  fallback list` before continuing.
- `council doctor`, `council config`, `council demo`, and `council docs` never
  trigger the wizard — run `council doctor` to verify your setup or
  `council config` to change the default model later.

---

## Why Council?

ChatGPT gives you **one perspective**. Council gives you **structured deliberation** from multiple expert viewpoints — with memory, disagreement, and synthesis.

| You ask...                        | Single AI says...      | Council deliberates...                                                                                                          |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| "Build or buy analytics?"         | Generic pros/cons list | CTO estimates build cost, CFO models 3-year TCO, VP Product argues speed to insight — synthesis names the real risk             |
| "Should we add a freemium tier?"  | Balanced advice        | VP Growth projects conversion funnels, CFO flags margin erosion, Head of CS warns about support load — genuine disagreement     |
| "Should we use microservices?"    | Generic pros/cons list | CTO argues operational risk, PM argues time-to-learning, Adversary challenges both — then synthesis names the crux              |
| "Review this auth middleware"     | Unified feedback       | Security auditor flags JWT expiry, performance engineer finds N+1, future maintainer asks "will I understand this in 6 months?" |
| "Should I take the manager role?" | Balanced advice        | IC mentor argues stay, manager argues switch, career coach provides a decision framework                                        |

---

## Core Features

- **Auto-composition:** Describe your problem; Council designs an expert panel for you.
- **Persistent memory:** Experts remember prior debates and evolve their perspectives across sessions.
- **Anti-sycophancy enforcement:** 3-layer quality gate ensures genuine disagreement and specificity (forbidden phrases, disagreement budget, concrete evidence requirements).
- **Structured & freeform modes:** 4-phase choreography (opening → cross-exam → rebuttal → synthesis) or flexible moderated discussion.
- **Document-driven persona experts:** Ground experts in your own reference material (CVs, RFCs, design docs, transcripts) for domain-specific voice and expertise.
- **Persistent chat:** 1:1 conversations with experts or multi-expert panel chat with `@mention` support and inline debates.
- **Export & share:** Markdown, JSON, ADR (Architecture Decision Record), and shareable formats.

**Shipped:** Phases 1–7.6 complete ([ROADMAP.md](./ROADMAP.md)). CLI includes `convene`, `ask`, `chat`, `conclude`, `resume`, `export`, `sessions`, `templates`, `expert`, `panel`, `memory`, `doctor`, `docs`, `config`, `telemetry`, and `update`.

---

## Demo

```bash
$ council convene "Should we build our own analytics or buy a vendor solution?"

🏛️  Panel assembled:
  • [1] Priya Mehta (CTO) (claude-sonnet-4.5)
  • [2] James Whitfield (CFO) (claude-sonnet-4.5)
  • [3] Lisa Park (VP Product) (claude-sonnet-4.5)

━━━ Round 1 ━━━

[[1] Priya Mehta (CTO)]
Building in-house gives us full control over the data pipeline, but we need
to be honest about the cost: a team of 3 engineers for 6+ months, ongoing
maintenance, and we still won't match the feature set of Amplitude or Mixpanel
on day one...

[[2] James Whitfield (CFO)]
Priya's estimate undersells the true cost. Three engineers at $180K fully
loaded is $270K just in salary for the build phase. A vendor at $3K/month is
$36K/year. Even over 3 years, the buy option is 60% cheaper — and that's
before we account for opportunity cost of those engineers not shipping product...

[[3] Lisa Park (VP Product)]
Both of you are optimizing for cost, but the real question is speed to insight.
We're making pricing decisions next quarter with no data. A vendor gets us
dashboards in 2 weeks. Building means we're flying blind for 6 months...

━━━ Synthesis ━━━
The panel splits on build vs. buy but converges on one point: the 6-month
data gap is the real risk. Start with a vendor, ring-fence the build option
for year two if data ownership becomes a competitive advantage...
```

---

## Learn More

- **[Installation & First Debate](packages/site/src/content/docs/tutorials/01-install-and-first-debate.mdx)** — Get started in 5 minutes
- **[Tutorials](packages/site/src/content/docs/tutorials/)** — Step-by-step guides for key workflows
- **[How-To Guides](packages/site/src/content/docs/how-to/)** — Practical recipes for common tasks
- **[Architecture & Concepts](packages/site/src/content/docs/explanation/)** — Understand deliberation model, anti-sycophancy, memory, and RAG
- **[Reference](packages/site/src/content/docs/reference/)** — CLI command reference and API docs
- **[ROADMAP.md](./ROADMAP.md)** — Completed phases (1–7.6) and Phase 8 plans (GitHub Action, direct provider APIs, telemetry)
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — Development setup, testing, and contribution guidelines

---

## Commands at a Glance

```bash
# Getting started
council doctor                                      # Verify Node, SQLite, Copilot SDK, disk
council config                                      # View/edit configuration

# Run a deliberation
council convene "Should we go public?"              # Auto-compose a panel (asks to confirm; add --yes to skip)
council convene "..." --template code-review        # Use built-in template (no confirmation prompt)
council templates                                   # List all built-in templates

# Conversation
council ask <expert> "What do you think?"           # One-shot question to a single expert
council chat <expert-or-panel>                      # Persistent 1:1 or panel chat
council resume <panel>                              # Show transcript or continue debate

# Decision framework
council conclude <panel>                            # Synthesize into decision matrix

# Export & inspect
council export <panel>                              # Export to markdown (or --format adr/json)
council sessions                                    # List all past debates
council memory list                                 # Summary of all panels
council memory inspect <panel>                      # Detail view

# Manage library
council expert create                               # Interactive wizard for new expert
council expert create --persona                     # Persona expert (with docs/ folder)
council panel create                                # Create a custom panel
council expert list                                 # View your expert library
council panel list                                  # View your panels

# Keep up to date
council update                                      # Upgrade to latest published version
```

`council --help` (and bare `council help`) print this list **grouped into
labelled sections** — Getting Started, Deliberation, Conversation, Library, and
Inspection — instead of one flat list, and close with an onboarding cue so a
brand-new setup always has an obvious next step:

```text
Commands:

Getting Started:  doctor, demo, config, telemetry, docs, update, ui
Deliberation:     convene, resume, conclude, review
Conversation:     ask, chat
Library:          expert, panel, templates
Inspection:       sessions, memory, export

New to Council? Start with: council doctor
```

In the real terminal each command sits on its own line with a one-line
description; the grouped section order above is what you see.

---

## Built-in Panels

Council ships with **17 built-in expert panels** covering engineering, product, go-to-market, finance, people, legal, and executive decisions. Each panel is pre-configured with domain experts who bring distinct perspectives and genuine disagreement.

### Engineering

| Panel                 | Use for...                                                         |
| --------------------- | ------------------------------------------------------------------ |
| `architecture-review` | Multi-perspective review of architecture and engineering decisions |
| `code-review`         | Multi-perspective code review with separated concerns              |
| `incident-postmortem` | Blameless analysis of a production incident                        |

### Product & Design

| Panel                     | Use for...                                              |
| ------------------------- | ------------------------------------------------------- |
| `product-strategy-review` | Pressure-tests a product strategy or major bet          |
| `roadmap-prioritization`  | Turns a noisy backlog into a defensible ranked roadmap  |
| `ux-review`               | Reviews a user experience — a flow, screen, or redesign |

### Go-to-Market

| Panel                      | Use for...                                                                  |
| -------------------------- | --------------------------------------------------------------------------- |
| `brand-positioning-review` | Pressure-tests a brand and positioning decision from five conflicting seats |
| `enterprise-deal-review`   | Reviews a high-stakes enterprise deal from five seats                       |
| `growth-experiment-review` | Reviews a growth experiment before launch or before shipping the "winner"   |
| `negotiation-prep`         | Prepares for a high-stakes negotiation from five seats                      |
| `pricing-packaging-review` | Stress-tests a pricing and packaging decision                               |

### Finance, People, Legal & Executive

| Panel                           | Use for...                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `executive-strategy-board-prep` | Prepares an executive team for a board meeting or major strategy decision                      |
| `fpna-budget-review`            | Pressure-tests an annual or quarterly budget (decision-support, not financial advice)          |
| `hiring-decision-review`        | Stress-tests a hiring decision before the offer (decision-support, not professional HR advice) |
| `legal-risk-review`             | Reviews a contract, launch, or risk decision (decision-support, not legal advice)              |

### Startup & Career

| Panel                | Use for...                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| `career-coaching`    | Career-decision panel for engineers weighing IC vs. management or job changes |
| `startup-validation` | Stress-test a startup or product idea                                         |

**Usage:** `council convene "<topic>" --panel <name>`  
**See all:** `council templates`

---

## Example Use Cases

- **Architecture review:** Multi-expert deliberation on technical decisions (microservices, build vs. buy, tech stack)
- **Code review:** Security auditor + performance engineer + future maintainer review PRs or modules
- **Incident postmortem:** Analyze failures with multiple expert perspectives on root cause and remediation
- **Career decisions:** IC mentor + manager + career coach deliberate on role changes, negotiation, growth
- **Startup strategy:** CEO + CFO + VP Product debate product-market fit, pricing, fundraising timing

---

## Documentation & Community

- **Documentation:** [packages/site/](packages/site/src/content/docs/) — Tutorials, how-to guides, reference, architecture
- **Roadmap:** [ROADMAP.md](./ROADMAP.md) — Completed phases and Phase 8 plans
- **Contributing:** [CONTRIBUTING.md](./CONTRIBUTING.md) — Development setup, testing, pull requests
- **Issues:** [GitHub Issues](https://github.com/pedrofuentes/Council/issues) — Bug reports and feature requests
- **License:** [MIT](LICENSE)

---

## What's Next

Below you'll find the full CLI reference, advanced usage patterns, persona expert setup, and deep-dive explanations of Council's deliberation model, anti-sycophancy enforcement, memory system, and document intelligence (RAG).

**New to Council?** Start with `council doctor` to verify your setup, then run `council convene "your first question"`.

---

## Full CLI Reference

```bash
# Verify your setup
council config show                # print effective config values with sources
council config path                # print config file location
council config edit                # open in $EDITOR

# Auto-compose a panel from the topic (no --template needed — Council
# designs an expert panel for you using a meta-prompt). Council prints the
# proposed roster and asks "Proceed with this panel? [y/N]" before debating.
council convene "Should we go public?"

# Skip the auto-compose confirmation prompt. --yes is REQUIRED for
# non-interactive / CI runs: a non-TTY shell without it exits with
# "Auto-compose requires --yes in non-interactive mode" instead of prompting.
council convene "Should we go public?" --yes

# Override the default model for a single debate (no config edit needed)
council convene "Should we go public?" --model gpt-4.1

# Run a panel debate against the real Copilot SDK (with an explicit template).
# Passing --template (or its --panel alias) selects a ready-made panel and
# skips auto-composition and its confirmation prompt entirely.
council convene "Should we rewrite our billing system?" \
  --template code-review --max-rounds 4

# --panel is a shorthand alias for --template
council convene "Review our API" --panel code-review

# Tip: single-quote topics containing $, backticks, or other shell metacharacters
council convene 'What is the $cost of `make build`?'

# Press Ctrl+C at any time during a debate to abort gracefully — the partial
# transcript is saved and you can `council resume` later. A second Ctrl+C
# force-kills the process.

# Or run offline with the deterministic mock engine (for testing/CI). No
# --template is required: with --engine mock, auto-compose skips the LLM and
# returns a fixed built-in panel (an Optimist, a Skeptic, and a Pragmatist), so
# the run makes zero network calls. The auto-compose roster confirmation still
# applies, so add --yes for non-interactive / CI runs.
council convene "Test prompt" --engine mock --yes
# Pinning --template with --engine mock still works and skips auto-compose:
council convene "Test prompt" --template code-review --engine mock

# Suppress non-essential stderr output (informational messages)
council convene "Topic" --quiet

# Force ASCII symbols (environment-driven: COUNCIL_ASCII=1, NO_COLOR, or TERM=dumb)
COUNCIL_ASCII=1 council convene "Topic"

# Use structured 4-phase choreography (opening → cross-exam → rebuttal → synthesis)
council convene "Should we ship the MVP?" --template architecture-review \
  --mode structured

# Choose a moderator strategy for freeform debates (default: round-robin)
council convene "Ship now or wait?" --template code-review \
  --strategy consensus-check
council convene "Ship now or wait?" --template code-review \
  --strategy devils-advocate:senior   # pin "senior" as the contrarian

# Tame long debates with context-window management
council convene "Long architectural debate" --template architecture-review \
  --max-rounds 10 \
  --context-scope recent          # only the most-recent turns are passed forward
council convene "Long debate" --template architecture-review \
  --max-rounds 10 \
  --context-scope same-round      # each expert only sees its round-mates
council convene "Long debate" --template architecture-review \
  --max-rounds 10 \
  --summarize-after 3             # prepend a rolling summary after round 3
# Rolling summaries are generated by the LLM by default. Add --heuristic-summaries
# for a simpler local (no-LLM) summarizer — useful for offline/air-gapped runs.
council convene "Long debate" --template architecture-review \
  --max-rounds 10 \
  --summarize-after 3 --heuristic-summaries

# Pipe NDJSON output to jq, logs, or scripts
council convene "..." --template code-review --format json | jq .
# Completed debates emit {"kind":"conclusion","conclusion":{...}} as the final
# NDJSON line after debate.end, unless you pass --no-conclude.

# Show the transcript of a previous debate
council resume <panel-name>

# Continue a previous panel with a new prompt
council resume <panel-name> --prompt "What about the migration risk?"

# Export a panel transcript for sharing — includes the full multi-debate
# history of the panel (every original + resumed debate, with globally
# renumbered rounds), not just a single debate.
council export <prefix>                             # prefix match (auto-selects if unique;
                                                    # ambiguous prefixes open a picker on a TTY, or list matches and
                                                    # exit non-zero when non-interactive; see the resolver notes below)
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
# Slug conflicts are keyed off <slug>.yaml. If the YAML was deleted but a stale
# expert_library row remains, `council expert create --slug <slug> ...` recreates
# the YAML and refreshes the cache automatically.

# Chat 1:1 with a persona expert — drop reference docs in
# ~/Council/experts/<slug>/docs/ (any supported format — run "council docs formats").
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
council panel docs <name>                                  # list indexed docs (DB read — no scan)
council panel docs list <name> --refresh                   # re-scan managed + linked folders, then list
council panel docs link <name> --path <folder> [--yes]     # link an external folder (symlinks rejected; prompts unless --yes)
council panel docs unlink <name> --path <folder>           # remove a linked folder + its FTS entries
```

### Resolving a panel by name or prefix

`council resume`, `council conclude`, and `council export` share one resolver
for turning the panel argument into a stored session, so all three behave the
same way:

- **Exact match** — an argument that exactly matches a session name is used as-is.
- **Unique prefix** — a prefix that matches exactly one session auto-selects it.
- **Ambiguous prefix** — when a prefix matches several sessions, an interactive
  terminal shows a numbered picker (`Select a panel [1-N] (Enter to cancel):`),
  while a non-interactive shell (piped output or CI) instead lists the matches
  and exits non-zero (`Ambiguous prefix '<p>' matches N panels.`) so scripts
  fail loudly instead of guessing.
- **No match** — Council prints the closest `Did you mean …?` suggestions and
  exits non-zero.

`council resume --latest` ignores the argument and reopens the most recently
active panel; `council conclude` with no argument falls back to the most
recently debated panel.

### Output format and TTY detection

Streaming debate commands (`convene`, `resume`, `ask`, `review`) accept
`--format auto|plain|json` (default `auto`):

- **`auto`** renders the interactive Ink TUI when stdout is a TTY, and falls back to
  plain streaming text when it is not (piped output, `CI=true`, `TERM=dumb`, or
  `ACCESSIBILITY=1`). This is the human-friendly default.
- **`plain`** always streams plain text, regardless of TTY.
- **`json`** always emits newline-delimited JSON (NDJSON) — one event per line —
  regardless of TTY.

Explicit `--format plain|json` overrides the `auto` TTY check, so scripts and CI get a
**stable, predictable renderer instead of the interactive TUI**. In particular,
`--format json` stays pure NDJSON when redirected or piped (e.g. `… --format json | jq .`) —
the determinism guarantee automation relies on. `council resume <panel>` transcript
replay additionally coerces `auto` to `plain` (a static replay gains nothing from the
Ink TUI); pass `--format json` for machine-readable transcript output. See
[DECISIONS.md](./DECISIONS.md) → ADR-030 for the rationale.

### Streaming and chat output

While a debate streams in plain output (either `--format plain` or the
non-interactive `auto` fallback), a **recoverable** engine error — a transient
rate-limit or network blip — is printed with a `— retrying automatically`
suffix, so an auto-retried hiccup is easy to tell apart from a fatal error;
Council retries such failures before giving up.

`council chat` adds a few interactive touches on top of the plain stream:

- A dim `thinking...` indicator is shown next to the expert's prompt the moment
  it is queried, and is overwritten in place by the expert's name as soon as the
  first token arrives.
- Multi-line replies are indented — each continuation line is prefixed with two
  spaces so a long answer stays visually attached to the expert who is speaking.
- A reply that fails with a recoverable error prints
  `Transient error from engine. Retrying once...` and is retried a single time.

## Keeping Council Up to Date

`council update` upgrades the globally-installed `@council-ai/cli` to the latest
published version. It auto-detects the package manager that owns the install
(npm, pnpm, yarn, or bun), shows the exact command it will run, and asks for
confirmation before shelling out.

```bash
council update                      # detect the package manager and upgrade (prompts first)
council update --yes                # skip the confirmation prompt
council update --dry-run            # print the upgrade command without running it
council update --pm pnpm            # force a specific package manager (npm | pnpm | yarn | bun)
```

The upgrade runs via an argv-array `execFile` (never a shell string) with a
fixed `@council-ai/cli@latest` spec, so no untrusted input is interpolated into
the spawned command. The child process is bounded for robustness:

- **Timeout** — the install is terminated after 5 minutes; a wedged package
  manager can't hang `council update` forever.
- **Output buffer** — up to 64 MiB of stdout/stderr is captured (well above
  Node's 1 MiB default), so a verbose `npm i -g` is never falsely reported as a
  failure.
- **Clear failures** — a non-zero exit, a timeout, a signal kill, and an
  output-buffer overflow are each reported distinctly with the captured output,
  and are never mislabelled as "package manager not installed".

Exit codes follow the usual convention: `0` when already up to date or after a
successful upgrade, and a non-zero code on failure — including a distinct
network error code when the registry can't be reached (so "offline" is
distinguishable from "already up to date" in scripts).

## Persona Experts & Document Intelligence

A **persona expert** is one whose voice is shaped by a corpus of reference
documents (CVs, design docs, RFCs, prior emails, transcripts). Create one
with `council expert create --persona --slug <slug>` — Council provisions
`~/Council/experts/<slug>/docs/` and the expert is registered with
`kind: "persona"`.

**On every `council chat <persona-slug>` invocation** (Roadmap 6.1, 6.2,
6.4, 6.8):

1. **Detect** new, modified, and deleted files by SHA-256 checksum
   against the `expert_documents` table (defined in `src/memory/migrations/001_unified.sql`).
2. **Extract** content from any of the 16 registered formats via the
   modular extractor registry (`src/core/documents/extractors/`) —
   a TOCTOU-safe fd-bound read dispatches to the format-specific
   extractor registered for the file's extension (or detected from its
   magic bytes). Run `council docs formats` for the full list.
3. **Index** the normalised text into FTS5 (`document_index`) for retrieval-augmented prompts.
4. **Analyze** the corpus into a structured `PersonaProfile`
   (`communicationStyle`, `decisionPatterns`, `biases`, `vocabulary`,
   `epistemicStance`) via a transient LLM "Profile Analyzer" expert. The
   profile is persisted to `persona_profiles` and
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

## Supported Document Formats

Council's built-in extractor registry covers 16 file types. Native text-based formats
need no conversion; rich-document formats are converted to plain text before indexing.

**Native (no conversion needed):**

| Extension          | Format     |
| ------------------ | ---------- |
| `.md`, `.markdown` | Markdown   |
| `.txt`             | Plain text |
| `.html`, `.htm`    | HTML       |

**Rich documents (converted to text):**

| Extension | Format                                        |
| --------- | --------------------------------------------- |
| `.pdf`    | PDF                                           |
| `.docx`   | Word document                                 |
| `.pptx`   | PowerPoint presentation                       |
| `.xlsx`   | Excel spreadsheet                             |
| `.xls`    | Legacy Excel (re-save as `.xlsx` recommended) |
| `.csv`    | Comma-separated values                        |
| `.tsv`    | Tab-separated values                          |
| `.rtf`    | Rich Text Format                              |
| `.odt`    | OpenDocument Text                             |
| `.ods`    | OpenDocument Spreadsheet                      |
| `.odp`    | OpenDocument Presentation                     |

### Document commands

```bash
council docs formats               # list supported formats, AI-extraction status, and size limit
council docs review <panel>        # list files that failed extraction or use unsupported formats
                                   #   (exits non-zero when any are present — CI-friendly)
council docs extract <panel>       # run AI extraction on files held for review (ask mode):
                                   #   prompts for confirmation, then extracts and indexes them
council docs doctor <panel>        # document-health diagnostics: indexed count, word count,
                                   #   pending review, corrupt files, AI-extraction mode
```

### Document configuration

| Key                                       | Values                   | Default                                                     | Description                                    |
| ----------------------------------------- | ------------------------ | ----------------------------------------------------------- | ---------------------------------------------- |
| `documents.maxFileSizeMB`                 | 1–500                    | `50`                                                        | Maximum file size the extractor will read      |
| `documents.aiExtraction`                  | `off` \| `ask` \| `auto` | `off`                                                       | AI-based fallback for unsupported formats      |
| `documents.aiExtractionAllowedExtensions` | list of extensions       | `[]` (all eligible)                                         | Restrict AI extraction to specific extensions  |
| `expert.supportedFormats`                 | list of extensions       | 14 extensions (all above **except** `.markdown` and `.htm`) | Formats a panel's document scanner will accept |

Configure with `council config set <key> <value>` or open `~/.council/config.yaml` with `council config edit`.

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
5. **Interruptible** — press Ctrl+C during a debate to abort gracefully; Council saves the partial transcript (`Debate interrupted. Partial results saved.`), and a bare `council resume <panel>` then automatically continues the interrupted debate from where it stopped instead of just replaying it

### What Makes Council Different

- **Expertise as prior, not persona** — Experts have distinct _objective functions_, not just different labels. Disagreement emerges naturally from weighing evidence differently.
- **Anti-sycophancy by design** — 3-layer system prevents experts from agreeing with each other reflexively: forbidden phrases, mandatory disagreement budget, identity stakes.
- **Persistent memory** — Experts remember past positions, updated priors, and unresolved questions across sessions. By default, an LLM extraction pass runs at the end of each debate and persists structured memory per expert; the next debate recalls that distilled context instead of a heuristic scan. Pass `--heuristic-memory` to convene/resume to opt out (e.g. for offline or air-gapped runs).
- **CLI-native** — Built for developer workflows. Pipe-friendly (`--format json`), scriptable, CI-compatible.
- **Zero key management** — Uses GitHub Copilot SDK. One auth, all models (GPT, Claude, Gemini).

## Commands

```bash
# Debate orchestration (engine defaults to copilot; pass --engine mock for offline/CI)
council convene <topic>                                        # Auto-compose a panel + start deliberation
council convene <topic> --template <name>                      # Use a built-in or library panel
council convene <topic> --no-conclude                          # Skip the default final conclusion synthesis
council ask <panel> "<question>"                               # One-shot to one expert (default: first; pin with --expert <slug>)
council conclude [panel]                                       # Decision matrix + recommendation
council conclude [panel] --timeout 90000                      # Custom synthesis timeout (ms)
council conclude [panel] --model gpt-4.1                       # Override the synthesis model for this run
council convene <topic> --model <model-id>                     # Override the per-debate model
council resume <panel>                                          # Replay transcript — or auto-continue if the latest debate was interrupted
council resume <panel> --prompt "<prompt>"                      # Continue the panel with a new round
council resume --latest                                         # Resume most recently active panel
council resume <prefix>                                         # Prefix match: unique auto-selects; ambiguous opens a picker (TTY) or lists + exits non-zero
council export <panel> --format <fmt>                          # Export (markdown | json | adr)

# Safety: every entry point (convene, ask, chat, in-REPL @convene) runs a warn-only
# topic-admission check first — sensitive topics emit "⚠ This topic touches sensitive
# areas (…)" but are never blocked.

# Persistent conversational chat (Phase 5) — engine defaults to copilot
council chat <expert-slug>                       # 1:1 conversational REPL with an expert
council chat <panel-name>                        # Group chat with a panel (supports @mentions, @convene)
# Panel chat prints the addressable expert roster at startup (e.g. "Experts:
# @sasha-cfo, @diego-cto …"); address one with @<slug>. Display-name mentions
# like @"Sasha Lin" are rejected with a hint, never silently broadcast.
council chat <target> --new                      # Archive active session and start fresh
council chat --list                              # List every chat session across all targets (no engine needed)
council chat <target> --history                  # Show active + archived sessions read-only (no engine needed)

# Expert library (Phase 4)
council expert create [--persona]           # Interactive wizard; also recreates ghost experts when <slug>.yaml is missing
council expert list [--format json]         # Browse the expert library
council expert inspect <slug>               # Full detail + panel memberships
council expert edit <slug>                  # Open YAML in $EDITOR; re-validates on save
council expert delete <slug> [--force]      # Refuses if expert is in any panel
council expert docs <slug>                  # Manage a persona expert's reference-docs folder
council expert train <slug> [--retrain] [--file <path>...] [--url <url>...]   # (Re-)run the persona profile analyzer; --file/--url ingestion is atomic (a failed input aborts before any file is added)

# Panel library (Phase 4)
council panel create <name>                 # Interactive wizard: pick experts, set description + mode
council panel save <session> [name]         # Promote an auto-composed convene session into a reusable library panel
council panel list [--format json]          # Browse panels in the library
council panel inspect <name>                # Panel metadata + resolved expert roster
council panel edit <name>                   # Open YAML in $EDITOR; re-validates on save
council panel delete <name> [--yes]         # Remove panel YAML + docs dir + DB rows (--yes skips prompt; hidden --force alias still works)
council panel docs <name>                   # List a panel's indexed docs (DB read; add `list <name> --refresh` to re-scan)
council panel docs link <name> --path <p>   # Link an external folder into a panel's RAG corpus (prompts; --yes to skip)
council panel docs unlink <name> --path <p> # Unlink a folder + clean up its FTS entries

# Configuration
council config show                         # Print effective config values with sources
council config path                         # Print config file path
council config edit                         # Open config in $EDITOR
council config set <key> <value>            # Set a single config value (dot-notation key)
council config model [name]                 # Set the default AI model: interactive picker on a TTY, or pass a name (non-interactive with no name lists models and exits non-zero)
council config wizard                        # Guided interactive setup for common config values

# Inspection & diagnostics
council sessions                            # List all debate sessions (with status/turns/experts)
council sessions cancel [name]              # Cancel running debates (mark interrupted); --all for every panel
council sessions delete <name>              # Delete a completed/interrupted session (prefix match, confirm unless --yes, blocks if running)
council templates                           # List built-in panel templates with descriptions
council templates inspect <name>            # Show template details (experts, mode, rounds)
council memory list                         # Show what experts remember
council memory inspect <panel>              # Per-panel + per-expert memory detail
council memory reset <panel> --yes          # Destructive: clear debate state
council models                              # List available Copilot models (live discovery with static fallback)
council doctor                              # Diagnose setup issues (incl. terminal capabilities)

# Document formats and health
council docs formats                        # List supported formats, AI-extraction status, size limit
council docs review <panel>                 # List files that failed extraction or are unsupported
                                            #   (exits non-zero when any are present — CI-friendly)
council docs extract <panel>                # Extract files held for review (ask mode); prompts to confirm
council docs doctor <panel>                 # Document-health diagnostics for a panel

# Global flags available on all commands
council <command> --quiet                   # Suppress informational stderr output and cost indicators

# ASCII mode (environment-driven, not a flag)
# Set COUNCIL_ASCII=1, NO_COLOR=1, or TERM=dumb to force ASCII symbols
COUNCIL_ASCII=1 council convene "Topic"
```

> `council sessions` (default `--format plain`) shortens each session's topic to
> 80 characters, appending `...`, so long topics stay on one scannable line.
> `--format json` is unaffected: it streams the full session record as NDJSON
> (one JSON object per line) with the complete, untruncated topic for scripting.

> Configuration lives in `~/.council/config.yaml` (auto-created on first run).
> Manage it with `council config show|path|edit`.

> `council config show` first prints the resolved filesystem locations, then the
> effective values (each annotated with its source). The path fields are:
>
> - **Config path** — the `config.yaml` currently in effect.
> - **Council home** — holds the config file and the `council.db` database
>   (default `~/.council`; override with `COUNCIL_HOME`). When `COUNCIL_HOME` is
>   unset, `COUNCIL_DATA_HOME` also relocates the Council home, so a single
>   `COUNCIL_DATA_HOME` override moves the config file and `council.db` alongside
>   the data home.
> - **Data home** — holds experts, panels, and documents (default `~/Council`;
>   override with `COUNCIL_DATA_HOME` or the `paths.dataHome` config value).
> - **Experts directory** / **Panels directory** — always `<data home>/experts`
>   and `<data home>/panels`.
> - **Database** — the SQLite file at `<council home>/council.db`.

> **Local database requirements:** Council's `council.db` runs in SQLite
> **WAL** (write-ahead logging) mode. On open it applies `PRAGMA busy_timeout =
> 5000` — so a momentarily locked database is retried for up to five seconds
> before erroring — and then `PRAGMA journal_mode = WAL`. If the filesystem
> holding the Council home cannot honour WAL (some network and virtualised
> mounts — e.g. certain NFS/SMB/9p shares — do not), startup fails fast with
> `Failed to enable SQLite journal mode WAL; got <mode>`. Point `COUNCIL_HOME`
> at a local, WAL-capable filesystem to resolve it.

> **Plural aliases**: `council panels`, `council experts`, and `council history` work as
> aliases for `council panel`, `council expert`, and `council sessions` respectively —
> use whichever feels more natural.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the high-level plan and [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md) for implementation details.

**Current focus:** Phase 8 — Growth & Ecosystem (`gh` extension, GitHub Action, direct provider APIs). Council already ships on npm as [`@council-ai/cli`](https://www.npmjs.com/package/@council-ai/cli), so the [Quick Start](#quick-start) `npm install -g @council-ai/cli` installs the released CLI.

## Contributing

We welcome contributions! The easiest way to start: **create a panel template** (YAML file in `packages/cli/panels/`) and submit a PR.

See [docs/DEVELOPMENT-WORKFLOW.md](./docs/DEVELOPMENT-WORKFLOW.md) for development setup.

## License

MIT © Pedro Fuentes
