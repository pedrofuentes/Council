# Council CLI — UX Design & Interaction Architecture

> A comprehensive UX design document for Council, an AI expert panel CLI tool.
> Written from the perspective of a Senior Product Designer & CLI UX Expert.

> **Status: forward-looking design document.** This describes the *intended* UX vision.
> Sections such as "Proposed Command Reference" and "Terminal Mockups" may describe commands,
> flags, and flows that are not yet implemented (or differ) in the shipped CLI. For the current,
> authoritative command surface, run `council --help` or see the [README](../README.md) and
> [GUIDE](./GUIDE.md).

---

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [User Journey Map](#user-journey-map)
3. [First-Run Experience](#first-run-experience)
4. [Terminal Rendering & Visual Language](#terminal-rendering--visual-language)
5. [Multi-Expert Conversation Design](#multi-expert-conversation-design)
6. [Information Architecture](#information-architecture)
7. [Command Design & CLI Grammar](#command-design--cli-grammar)
8. [Onboarding & Activation](#onboarding--activation)
9. [Error & Edge Case UX](#error--edge-case-ux)
10. [Competitive Benchmarking](#competitive-benchmarking)
11. [Terminal Mockups](#terminal-mockups)
12. [Proposed Command Reference](#proposed-command-reference)
13. [UX Risks & Mitigations](#ux-risks--mitigations)

---

## Design Philosophy

### Core Principles

1. **Progressive Disclosure** — Show only what's needed at each moment. A first-time user sees a simple chat; a power user discovers flags, templates, and routing.

2. **Conversational Gravity** — The conversation is the primary object. Everything else (config, memory, panel composition) orbits around it.

3. **Respectful Defaults** — Never ask a question the system can answer itself. Auto-detect, auto-compose, auto-save. Ask only when ambiguity is genuinely harmful.

4. **Spatial Metaphor: The Round Table** — Users should feel they're sitting at a table with experts, not managing a software tool. The CLI should feel like a place, not a pipeline.

5. **Speed to Value** — From `npm install -g council` to first useful insight: under 60 seconds.

---

## User Journey Map

### Phase 1: Discovery → Install (Day 0)
```
See README → npm install -g @council/cli → council
```

### Phase 2: First Session (Minute 1-5)
```
council convene "Should we migrate to microservices?"
  → Auto-detects: needs CTO, Architect, DevOps Lead, Product Manager
  → Panel assembles (animated)
  → First expert speaks
  → User observes the "aha moment" — experts disagree intelligently
```

### Phase 3: Active Use (Day 1-7)
```
council resume                    # pick up where you left off
council ask "What about costs?"   # continue the conversation
council ask --expert Architect "Draw the boundary map"
```

### Phase 4: Power Use (Day 7-30)
```
council convene --template architecture-review --from ./docs/rfc.md
council panel create "My Security Team" --experts "CISO, PenTester, AppSec Lead"
council export <panel> --format markdown > decision-log.md
```

### Phase 5: Workflow Integration (Day 30+)
```
git diff | council convene "Review this PR for security issues" --template code-review
council convene --stdin < requirements.txt "Estimate this sprint"
```

### Friction Points Identified

| Point | Risk | Mitigation |
|-------|------|------------|
| Auth setup | User bounces before first use | Detect GitHub Copilot token automatically; zero-config path |
| "What do I ask?" | Blank canvas paralysis | Suggest 3 contextual prompts based on CWD |
| Long responses | User loses attention | Stream with progress, allow skip/interrupt |
| Too many experts | Cognitive overload | Default to 3 experts; expand on request |
| Memory is opaque | User doesn't trust context | Show memory indicator; allow inspection |

---

## First-Run Experience

### Option A: Zero-Config (Recommended)

```
$ council

  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │   ◆ Council v0.1.0                                  │
  │                                                     │
  │   AI expert panels for better decisions.            │
  │                                                     │
  │   Quick start:                                      │
  │     council convene "your question or topic"        │
  │                                                     │
  │   Examples:                                         │
  │     council convene "Should we use GraphQL or REST?"│
  │     council convene "Review our auth architecture"  │
  │     council convene "Plan Q1 roadmap priorities"    │
  │                                                     │
  │   ✓ GitHub Copilot detected                        │
  │   ✓ Ready to go — no configuration needed          │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

### If Copilot Not Detected

```
$ council

  ┌─────────────────────────────────────────────────────┐
  │                                                     │
  │   ◆ Council v0.1.0                                  │
  │                                                     │
  │   ⚠ GitHub Copilot not found.                      │
  │                                                     │
  │   Council uses GitHub Copilot as its AI backend.    │
  │                                                     │
  │   To get started:                                   │
  │     1. Install GitHub Copilot CLI                   │
  │        → https://github.com/github/copilot-cli     │
  │     2. Authenticate: gh auth login                  │
  │     3. Run: council convene "your topic"            │
  │                                                     │
  │   Want to try without Copilot?                      │
  │     council demo                                    │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

### Design Decisions

- **No setup wizard.** Wizards feel heavy and enterprise-y. Council should feel instant.
- **Auto-detect everything.** If Copilot is available, just work. Store config only when user explicitly customizes.
- **Show capability, not configuration.** The first screen shows what you can DO, not what you need to SET UP.

---

## Terminal Rendering & Visual Language

### Color System

| Element | Color | Purpose |
|---------|-------|---------|
| Expert names | Distinct hue per expert (cyan, magenta, yellow, green, blue) | Identity |
| Expert role badge | Dim/muted version of expert color | Context without noise |
| User input | White/default | Clarity of "my words" |
| Moderator synthesis | Bold white on subtle background | Authority, summary |
| System messages | Dim gray | Low priority, non-intrusive |
| Disagreement markers | Amber/orange | Attention without alarm |
| Errors | Red | Standard convention |
| Success/consensus | Green | Positive signal |

### Typography Hierarchy

```
EXPERT NAME (Role)          ← Bold + Color
Response text here...       ← Normal weight, slightly indented
  └─ metadata: model, tokens  ← Dim, smaller

━━━ MODERATOR SYNTHESIS ━━━ ← Distinct separator
Summary text...             ← Bold white

─── You ────────────────── ← Subtle user delimiter
Your message here           ← Default color
```

### Expert Avatars/Identifiers

Each expert gets a Unicode symbol as a quick visual anchor:

```
◆ CTO (Strategy & Architecture)
◇ Architect (System Design)
● DevOps Lead (Infrastructure)
○ Security Engineer (Threat Analysis)
◈ Product Manager (User Impact)
```

These symbols appear inline and in the panel roster, creating spatial memory.

### Streaming Behavior

```
◆ CTO is thinking...          ← Shown immediately (spinner)
◆ CTO:                        ← Name appears when first token arrives
  Based on your current...    ← Streams token by token
  [█░░░░░░░░░] responding     ← Optional progress for long responses
```

---

## Multi-Expert Conversation Design

### The Core Challenge

When 5 experts respond to one question, presenting them sequentially takes too long. Presenting them simultaneously is overwhelming. The solution: **Layered Disclosure**.

### Pattern: Summary → Expand

```
━━━ PANEL RESPONSE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ◈ Moderator Synthesis:
  The panel has a split opinion. The CTO and Architect favor
  microservices for scalability, while DevOps and Security
  raise operational complexity concerns. Product sees risk
  in timeline.

  ┌─ Expert Positions ─────────────────────────────────┐
  │ ◆ CTO           → Supports migration (confidence: high)
  │ ◇ Architect     → Supports with caveats (confidence: med)
  │ ● DevOps Lead   → Opposes (confidence: high)
  │ ○ Security Eng  → Opposes (confidence: med)
  │ ◈ Product Mgr   → Neutral, concerned about timeline
  └────────────────────────────────────────────────────┘

  ⚡ Disagreement: CTO vs DevOps on operational readiness

  [Enter] continue  [1-5] expand expert  [d] show debate  [s] skip
```

### When User Expands an Expert (e.g., presses `1`):

```
  ◆ CTO (Strategy & Architecture):

  I strongly recommend proceeding with the microservices
  migration, but with a phased approach:

  1. Start with the authentication service — it's the most
     self-contained bounded context.
  2. Keep the monolith running in parallel for 6 months.
  3. Measure latency and ops cost at each phase gate.

  The scalability ceiling we're hitting isn't theoretical —
  we saw 3 incidents last quarter directly caused by the
  monolith's deployment coupling.

  Confidence: High
  Based on: System architecture analysis, incident history
  Tokens: 847 | Model: GPT-4

  [Enter] back to summary  [n] next expert  [r] respond to CTO
```

### Disagreement Highlighting

```
  ⚡ DISAGREEMENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Topic: Operational Readiness for Microservices

  ◆ CTO argues:
  "The ops complexity is manageable with our current team
   size. We've already adopted Kubernetes."

  ● DevOps Lead counters:
  "K8s adoption ≠ microservice readiness. We have 0
   experience with distributed tracing, service mesh,
   or multi-service deployment orchestration."

  Resolution options:
    a) Ask panel to find compromise
    b) Request specific data/evidence from each
    c) Bring in additional expert (SRE perspective)
    d) Move on — note as open question

  Choice [a/b/c/d]:
```

### Sequential Streaming Mode (for real-time feel)

When the user prefers watching the conversation unfold:

```
  ◆ CTO is responding...
  ━━━━━━━━━━━━━━━━━━━━━ streaming ━━━━━━━━━━━━━━━━━━━━━

  The core question isn't whether to migrate, but when and
  how. Given our growth trajectory—

  [Ctrl+S] skip to next expert  [Ctrl+C] interrupt all
```

### Interruption Model

- **Ctrl+S** — Skip current expert, move to next
- **Ctrl+C** — Stop all responses, return to prompt
- **Ctrl+D** — Skip remaining experts, show synthesis immediately
- **Tab** — Switch between streaming view and summary view

---

## Information Architecture

### Mental Model: The Round Table

```
                    ┌─────────────┐
                    │  MODERATOR  │
                    │  (AI/Auto)  │
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────┴────┐      ┌────┴────┐      ┌────┴────┐
    │ Expert  │      │  YOU    │      │ Expert  │
    │   #1    │      │ (Human) │      │   #2    │
    └─────────┘      └─────────┘      └─────────┘
         │                                   │
    ┌────┴────┐                        ┌────┴────┐
    │ Expert  │                        │ Expert  │
    │   #3    │                        │   #4    │
    └─────────┘                        └─────────┘
```

Users are **participants at the table**, not operators of a machine. They:
- Pose questions to the table (broadcast)
- Speak to individual experts (direct)
- Ask the moderator to synthesize or redirect
- Can invite new experts to the table mid-session

### Panel Organization

```
$ council sessions

  YOUR PANELS
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Recent Sessions
  ┌──────────────────────────────────────────────────────┐
  │ ● Microservices Migration    3 days ago   5 experts  │
  │   Last: "What about the database split?"             │
  │                                                      │
  │ ○ Q1 Roadmap Planning       1 week ago   4 experts  │
  │   Last: "Prioritize auth or search?"                 │
  │                                                      │
  │ ○ Security Audit Review     2 weeks ago  3 experts   │
  │   Concluded — decision recorded                      │
  └──────────────────────────────────────────────────────┘

  Saved Templates
  ┌──────────────────────────────────────────────────────┐
  │ ◆ Architecture Review    CTO, Architect, DevOps      │
  │ ◆ Code Review           Security, Performance, UX    │
  │ ◆ Sprint Planning       PM, Tech Lead, Designer      │
  └──────────────────────────────────────────────────────┘

  council resume           # continue most recent
  council resume --pick    # choose from list
  council panel create     # make a new template
```

### Memory Surface

Show memory presence without overwhelming:

```
◆ CTO (Strategy & Architecture)
  Memory: ████░░░░░░ 12 past interactions
  Context: Knows your tech stack, team size, last 3 decisions
  [m] view memory summary
```

---

## Command Design & CLI Grammar

### Grammar Philosophy

```
council <verb> [noun] [--modifiers]
```

The grammar should feel like English:
- `council convene "topic"` — "Council, convene on this topic"
- `council ask "question"` — "Council, I'm asking this"
- `council ask --expert CTO "question"` — "Council, I'm asking the CTO this"
- `council resume` — "Council, let's resume"
- `council conclude` — "Council, let's wrap up"

### Complete Command Tree

```
council                          # Show status + quick start
council convene <topic>          # Start new panel session
  --experts "CTO, Architect"    # Specify experts (override auto)
  --template <name>             # Use panel template
  --from <file>                 # Seed with file content
  --stdin                       # Pipe input as context
  --model <model>               # Override default model
  --quick                       # 2-3 experts, concise answers

council ask [message]            # Send message to active panel
  --expert <name>               # Direct to specific expert
  --all                         # Require response from all (default)
  --broadcast                   # All hear it, only relevant respond

council resume                   # Continue most recent session
  --pick                        # Interactive session picker
  --session <id>                # Resume specific session

council conclude                 # Wrap up with final synthesis
  --export md|json|html         # Export conversation
  --decision <text>             # Record the final decision

council panel                    # Panel management
  panel list                    # Show saved panels/templates
  panel create <name>           # Create reusable panel
  panel show <name>             # Show panel composition
  panel edit <name>             # Modify panel

council expert                   # Expert management
  expert list                   # Available expert archetypes
  expert add <name>             # Add expert to active session
  expert remove <name>          # Remove from active session
  expert memory <name>          # View/manage expert memory

council config                   # Configuration
  config show                   # Current config
  config set <key> <value>      # Set value
  config reset                  # Reset to defaults

council history                  # Session history
  history list                  # All past sessions
  history search <query>        # Search past conversations
  history export <session-id>   # Export a session

council demo                     # Run interactive demo (no API needed)
```

### Interactive Mode vs Flags

**Rule: Flags for scripting, prompts for exploration.**

```
# Scripting (CI, pipes, automation):
echo "Review this" | council convene --template code-review --quick --export json

# Exploration (human at terminal):
$ council convene "How should we handle auth?"
  Panel auto-composed: CTO, Security Engineer, Backend Architect
  Start session? [Y/n]
```

---

## Onboarding & Activation

### The "Aha Moment"

The aha moment is: **Seeing experts disagree intelligently about YOUR specific problem.**

This happens when:
1. User asks a real question they're actually facing
2. Experts give substantively different perspectives
3. User realizes they hadn't considered one of those angles

**Fastest path to aha: 45 seconds**

```
$ council convene "Should we use PostgreSQL or MongoDB for our new service?"

  Assembling panel...
  ◆ Database Architect  ◇ Backend Lead  ● DevOps Engineer

  ◆ Database Architect:
  "For a service with relational data and ACID requirements,
   PostgreSQL is almost always the right choice..."

  ◇ Backend Lead:
  "I'd push back slightly — if the service is event-sourced..."

  ● DevOps Engineer:
  "From an operational standpoint, PostgreSQL. We already
   run it, we know how to back it up..."

  ⚡ Key tension: Data model fit vs operational simplicity
```

### Demo Mode

```
$ council demo

  ◆ Council Demo Mode
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  This is a pre-recorded session showing Council in action.
  No API calls are made.

  Topic: "Should we rewrite our frontend in React or Vue?"

  [Enter] to advance  [s] skip to synthesis  [q] quit

  ◆ Frontend Architect:
  "Both are excellent choices in 2024, but the decision
   hinges on three factors..."
```

### Built-in Templates (Drive Engagement)

```
council convene --template list

  BUILT-IN TEMPLATES
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🏗️  architecture-review     CTO, Architect, DevOps, Security
  🔍  code-review             Security, Performance, Maintainability
  📋  sprint-planning         PM, Tech Lead, Designer, QA
  🚀  launch-readiness        PM, SRE, Security, Legal
  💡  brainstorm              Innovator, Critic, Pragmatist, User Advocate
  ⚖️  buy-vs-build            CTO, Finance, Engineering Lead, Vendor Analyst
  📊  incident-postmortem     SRE, Engineering Lead, PM, On-Call Engineer
  🎯  prioritization          PM, Engineering Lead, Designer, Data Analyst
```

### Handling Blank Canvas

When user runs `council convene` without a topic:

```
$ council convene

  What would you like the panel to discuss?

  Based on your current directory (~/projects/acme-api), you might want:

    1. "Review the architecture of this project"
    2. "What are the biggest technical risks here?"
    3. "How should we improve test coverage?"

  Or type your own topic:
  >
```

---

## Error & Edge Case UX

### Copilot Not Authenticated

```
$ council convene "topic"

  ✗ GitHub Copilot authentication required.

  Council uses GitHub Copilot as its AI backend.
  Run: gh auth login
  Then: gh extension install github/gh-copilot

  Need help? https://council.dev/setup
```

### Model Unavailable Mid-Conversation

```
  ◆ CTO:
  "I recommend we proceed with—"

  ⚠ Model unavailable for CTO (GPT-4). Retrying in 3s...
  ⚠ Still unavailable. Options:
    [r] Retry  [s] Skip CTO  [f] Fallback to GPT-3.5  [w] Wait

  Choice: f

  ◆ CTO (fallback model):
  "I recommend we proceed with the phased migration..."
```

### Rate Limiting

```
  ◇ Architect is responding...

  ⚠ Rate limit reached. Pausing for 45s.
  ━━━━━━━━━░░░░░░░░░░ 45s remaining
  Tip: Use --quick flag for shorter responses that use fewer tokens.

  Resuming...
  ◇ Architect:
  "The boundary between services should follow..."
```

### Token/Cost Awareness (Non-Annoying)

Show token usage **only in session summary**, not per-message:

```
$ council conclude

  SESSION SUMMARY
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Topic: Microservices Migration Strategy
  Duration: 23 minutes | 14 exchanges | 5 experts

  Decision: Proceed with phased migration starting Q2
  Confidence: Panel consensus (4/5 agree)

  Token usage: ~12,400 tokens (est. $0.37)
  ──────────────────────────────────────────

  Exported to: ./council-sessions/microservices-2024-01-15.md
```

Optionally, a running indicator in the prompt (opt-in via config):

```
council [~$0.12] > What about the database?
```

---

## Competitive Benchmarking

### Lessons from Best CLI Tools

| Tool | Lesson for Council |
|------|-------------------|
| **gh (GitHub CLI)** | Verb-noun grammar (`gh pr create`). Interactive fallbacks when flags missing. Beautiful table output. |
| **Vercel CLI** | Zero-config deploys → Council should be zero-config panels. Framework detection → problem detection. |
| **Railway CLI** | Project linking (`railway link`) → Session linking. Persistent context. |
| **Warp** | Blocks concept (grouping output). AI integration that feels native, not bolted on. |
| **lazygit** | Full TUI when needed, but keyboard-driven. Good for Council's "expand/collapse" views. |
| **fig/Amazon Q** | Inline completions. Council could suggest follow-up questions inline. |

### Chat Application Patterns → CLI Translation

| Chat Pattern | CLI Translation |
|-------------|----------------|
| Discord threads | `council ask --thread "subtopic"` for focused sub-discussions |
| Slack reactions | Quick feedback: `council react 👍` to indicate agreement with last expert |
| iMessage tapbacks | Lightweight signals without typing a full response |
| Discord roles/colors | Expert color coding + role badges |
| Slack channels | Multiple active panels (like channel switching) |
| Read receipts | Show which experts have "processed" your message |

### Council's Signature Interaction

**The Synthesis Moment** — When the moderator crystallizes 5 divergent opinions into a clear decision framework with tradeoffs explicitly named. No other tool does this.

Visual signature:

```
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   ◈ SYNTHESIS

   The panel recommends: Phased microservices migration

   ┌─ For ───────────────────┐  ┌─ Against ──────────────┐
   │ • Scalability ceiling   │  │ • Ops complexity      │
   │ • Deploy independence   │  │ • Team inexperience   │
   │ • Bounded contexts      │  │ • 6-month timeline    │
   └─────────────────────────┘  └────────────────────────┘

   Confidence: ████████░░ 80%
   Consensus:  4/5 agree (DevOps dissents on timeline)

   Suggested next step: "Define service boundaries for Phase 1"

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Terminal Mockups

### Mockup 1: Full Convene Flow

```
$ council convene "Should we adopt Kubernetes for our 10-person startup?"

  ◆ Council — Assembling Panel
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Topic: Should we adopt Kubernetes for our 10-person startup?

  Panel:
  ┌────────────────────────────────────────────────────────────────┐
  │  ◆ CTO              Strategy & technical direction             │
  │  ◇ DevOps Lead      Infrastructure & operational burden        │
  │  ● Startup Advisor  Stage-appropriate technology choices       │
  │  ○ SRE              Reliability & incident management          │
  └────────────────────────────────────────────────────────────────┘

  ─── Round 1 ─────────────────────────────────────────────────────

  ◆ CTO:
  At 10 people, Kubernetes is almost certainly premature. The
  operational overhead will consume 20-30% of one engineer's time
  — that's 10% of your engineering capacity just on infra tooling.

  Consider: What problem are you actually solving? If it's "we need
  to deploy reliably," there are much simpler answers.

  ◇ DevOps Lead:
  Hard agree with CTO. I've seen this pattern repeatedly:

    • Month 1-2: "K8s is amazing, we can do anything!"
    • Month 3-4: "Why is the cluster acting weird?"
    • Month 5-6: "We need to hire a dedicated K8s person"

  At your scale: Railway, Render, or even a single well-configured
  EC2 with Docker Compose will serve you for the next 2 years.

  ● Startup Advisor:
  The question I'd ask: what's your growth trajectory? If you're
  planning to 10x your team in 18 months (Series A incoming),
  starting with K8s now avoids a painful migration later. But if
  growth is linear, you're optimizing for a future that may not come.

  ○ SRE:
  One nuance: managed Kubernetes (EKS, GKE) removes ~60% of the
  operational burden. If the team has K8s experience, managed K8s
  at a startup is viable. If nobody knows K8s? Absolutely not.

  ⚡ Key tension: Future-proofing vs. present-day efficiency

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ◈ SYNTHESIS:
  Strong consensus against raw K8s adoption. Panel agrees on:
  • Use managed PaaS (Railway/Render) now
  • Re-evaluate at 25+ engineers or if deployment pain emerges
  • Exception: if team already has deep K8s expertise

  Confidence: ████████░░ 85% consensus

  ─── You ─────────────────────────────────────────────────────────
  > _
```

### Mockup 2: Expert Direct Chat

```
$ council ask --expert "CTO" "What about using ECS instead?"

  ─── You → CTO ──────────────────────────────────────────────────
  What about using ECS instead?

  ◆ CTO (direct):
  ECS is a reasonable middle ground. Here's my take:

  Pros over raw K8s:
  ├─ AWS-managed control plane (less ops burden)
  ├─ Familiar if team already uses AWS
  └─ Fargate mode = truly serverless containers

  Cons:
  ├─ AWS lock-in (harder to multi-cloud later)
  ├─ Still more complex than PaaS (networking, ALBs, etc.)
  └─ Terraform/IaC required to manage sanely

  My recommendation: If you're already on AWS and your team knows
  Docker, ECS Fargate is a solid "level 2" choice between PaaS
  and K8s. Start there if PaaS feels too limiting.

  ─── You → CTO ──────────────────────────────────────────────────
  > _

  [Esc] return to panel  [Tab] switch expert  [/] commands
```

### Mockup 3: Session Picker

```
$ council resume --pick

  ◆ Council — Resume Session
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ❯ ● Kubernetes Adoption          today, 4 experts, 6 turns
      Last: "What about using ECS instead?"

    ○ Database Selection            2 days ago, 3 experts, 12 turns
      Last: "How does Postgres handle JSON at scale?"

    ○ Q1 Roadmap Prioritization     1 week ago, 4 experts, 8 turns
      Last: "Agreed — auth first, search second"

    ○ Monorepo vs Polyrepo          2 weeks ago, 3 experts, 4 turns
      Concluded — decision: monorepo with Turborepo

  [↑↓] navigate  [Enter] resume  [d] delete  [e] export  [q] quit
```

### Mockup 4: Panel Status Bar (Persistent)

```
  ┌─ council ──────────────────────────────────────────────────────┐
  │ Panel: K8s Adoption │ Experts: 4 │ Turns: 6 │ ~$0.24 │ ●Live │
  └────────────────────────────────────────────────────────────────┘
```

---

## Proposed Command Reference

### Renamed/Improved Commands

| Original Idea | Proposed | Rationale |
|---------------|----------|-----------|
| `council chat` | `council ask` | "Chat" implies 1:1. "Ask" implies posing to a group. |
| `council chat --expert X` | `council ask --expert X` | Consistent grammar |
| N/A | `council status` | Quick view of active panel state |
| N/A | `council conclude` | Explicit session wrap-up with synthesis |
| N/A | `council invite <expert>` | Add expert mid-session (natural metaphor) |
| N/A | `council dismiss <expert>` | Remove expert (round table metaphor) |
| N/A | `council focus <topic>` | Redirect discussion without losing context |

### Short Aliases

```
council c  → council convene
council a  → council ask
council r  → council resume
council s  → council status
council e  → council expert
```

---

## UX Risks & Mitigations

### Risk 1: Response Time Feels Slow (CRITICAL)

**Problem:** With 5 experts, serial responses could take 30-60 seconds. Users will close the terminal.

**Mitigation:**
- Parallel API calls, stream results as they arrive
- Show the fastest-responding expert first
- Moderator synthesis starts generating while last expert finishes
- `--quick` flag for concise, fast responses (limit each expert to 2-3 sentences)

### Risk 2: Cognitive Overload (HIGH)

**Problem:** 5 long expert responses = wall of text nobody reads.

**Mitigation:**
- Default to Summary → Expand pattern (not full dump)
- Limit default panel to 3 experts (user explicitly adds more)
- `--concise` mode: each expert limited to 3 sentences
- Moderator always synthesizes into actionable bullet points

### Risk 3: "It's Just ChatGPT With Extra Steps" Perception (HIGH)

**Problem:** Users may not see the value over a single AI chat.

**Mitigation:**
- Engineer deliberate disagreement — experts MUST have different perspectives
- Show the synthesis as a decision matrix, not just text
- Demonstrate memory: "Based on your decision last week to use PostgreSQL..."
- Unique templates that no single-AI-chat provides (postmortem, architecture review)

### Risk 4: Memory Is Creepy/Confusing (MEDIUM)

**Problem:** Users don't understand what experts "remember" and feel surveilled.

**Mitigation:**
- Always show memory indicator (how much context expert has)
- `council expert memory CTO --show` to inspect
- `council expert memory CTO --clear` to reset
- Memory is per-panel, not global (unless user opts in)

### Risk 5: Naming/Discovery (MEDIUM)

**Problem:** Users don't know what commands exist or what experts are available.

**Mitigation:**
- Tab completion for everything (expert names, templates, session IDs)
- `council --help` shows examples, not just flags
- Contextual suggestions: "Try: council invite SecurityEngineer"
- Shell completions installed automatically on first run (with permission)

---

## Design Specifications Summary

### Visual Constants

```
MAX_LINE_WIDTH = 72 characters (content area)
INDENT_EXPERT_RESPONSE = 2 spaces
SEPARATOR_HEAVY = ━ (U+2501)
SEPARATOR_LIGHT = ─ (U+2500)
BULLET_TREE = ├─ └─ (U+251C, U+2514)
EXPERT_SYMBOLS = ◆ ◇ ● ○ ◈ ▪ (rotate per expert)
MODERATOR_SYMBOL = ◈
USER_DELIMITER = "─── You ───"
```

### Timing Constants

```
SPINNER_APPEAR_DELAY = 200ms (don't flash spinner for fast responses)
STREAM_FLUSH_INTERVAL = 50ms (smooth streaming appearance)
SUMMARY_TIMEOUT = 10s (show summary even if not all experts done)
PROGRESS_SHOW_THRESHOLD = 5s (show progress bar after 5s)
```

### Responsive Layout

```
< 60 cols: Compact mode (shorter separators, no box drawing)
60-100 cols: Standard mode (as shown in mockups)
> 100 cols: Wide mode (side-by-side expert responses possible)
```

---

## Implementation Priority

### Phase 1: Core Loop (MVP)
1. `council convene` with auto-panel composition
2. Streaming expert responses (sequential)
3. Basic moderator synthesis
4. `council ask` for follow-up
5. `council resume` for session continuity

### Phase 2: Polish
6. Summary → Expand pattern
7. Disagreement highlighting
8. Expert direct chat (`--expert`)
9. Session export
10. Tab completion

### Phase 3: Delight
11. Interactive TUI mode (full keyboard navigation)
12. `council demo` (works offline)
13. Memory inspection/management
14. Templates library
15. Pipe/stdin integration

---

*This document should be treated as a living design spec. Update as user research reveals new patterns.*
