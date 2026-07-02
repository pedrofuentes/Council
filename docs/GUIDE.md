# Council User Guide

> From your first debate to power-user workflows — everything you need to get the most out of Council.

Council is a CLI tool that creates **persistent AI expert panels** for deliberation
and decision-making. You ask a question, Council assembles a panel of experts who
debate it from different angles, and you get a structured recommendation you can
act on and share.

```
Your Question → Expert Panel ─┬─ Debate → Conclusion → Export
                  ▲            │                          │
                  │            └─ Chat (ongoing) ─────────┘
                  │          (resume anytime)              │
                  └───────────────────────────────────────-┘
```

## How to use this guide

| You want to…                              | Start at                                      |
| ----------------------------------------- | --------------------------------------------- |
| Run your first debate right now           | [Part 1: Your First Decision](#part-1)        |
| Use a built-in template                   | [Part 2: Using Built-in Templates](#part-2)   |
| Build a reusable expert panel             | [Part 3: Building Your Expert Panel](#part-3) |
| Find a recipe for a specific task         | [Part 4: How-to Guides](#part-4)              |
| Chat with experts or review documents     | [Part 4: Chat Mode](#chat-with-a-panel)       |
| Train an expert on your documents         | [Part 5: Creating a Persona Expert](#part-5)  |
| Script Council or use it in CI/CD         | [Part 6: Power User Patterns](#part-6)        |
| Look up a command, flag, or config option | [Part 7: Quick Reference](#part-7)            |

## Which command should I use?

| Your goal                           | Command            | Example                                       |
| ----------------------------------- | ------------------ | --------------------------------------------- |
| Get multiple expert perspectives    | `council convene`  | `council convene "Should we adopt GraphQL?"`  |
| Quick answer from one expert        | `council ask`      | `council ask strategy-review "Explain CQRS"`  |
| Ongoing conversation (1:1 or panel) | `council chat`     | `council chat strategy-review`                |
| Continue a previous debate          | `council resume`   | `council resume strategy-review`              |
| Get a structured decision framework | `council conclude` | `council conclude strategy-review`            |
| Export results to share             | `council export`   | `council export strategy-review --format adr` |
| Check your setup                    | `council doctor`   | `council doctor`                              |

## Which template should I use?

Council ships with **seventeen** built-in templates. Each comes pre-configured with a curated expert panel:

### Engineering

| You are deciding about… | Use this template     |
| ----------------------- | --------------------- |
| Technical architecture  | `architecture-review` |
| Code quality and design | `code-review`         |
| Production incidents    | `incident-postmortem` |

### Product & Design

| You are deciding about…        | Use this template         |
| ------------------------------ | ------------------------- |
| Product strategy or major bets | `product-strategy-review` |
| Backlog prioritization         | `roadmap-prioritization`  |
| User experience or redesigns   | `ux-review`               |

### Go-to-Market

| You are deciding about…  | Use this template          |
| ------------------------ | -------------------------- |
| Brand and positioning    | `brand-positioning-review` |
| Enterprise deals         | `enterprise-deal-review`   |
| Growth experiments       | `growth-experiment-review` |
| High-stakes negotiations | `negotiation-prep`         |
| Pricing and packaging    | `pricing-packaging-review` |

### Finance, People, Legal & Executive

| You are deciding about…    | Use this template               |
| -------------------------- | ------------------------------- |
| Board meetings or strategy | `executive-strategy-board-prep` |
| Budgets and forecasts      | `fpna-budget-review`            |
| Hiring decisions           | `hiring-decision-review`        |
| Contracts and legal risk   | `legal-risk-review`             |

### Startup & Career

| You are deciding about…  | Use this template    |
| ------------------------ | -------------------- |
| Career decisions         | `career-coaching`    |
| Startup or product ideas | `startup-validation` |

You can also skip templates entirely — Council will **auto-compose** a custom panel
tailored to your topic. See [Part 1](#part-1).

## Prerequisites

Before starting, make sure you have:

1. **Node.js 24 or later** installed
2. **Council installed globally**: `npm install -g @council-ai/cli`
3. **A GitHub Copilot subscription** (Individual, Business, or Enterprise)

No API keys, no OpenAI account, no credits to manage. Council uses the GitHub
Copilot SDK — if you can use GitHub Copilot in your editor, you can use Council.

> **New to the terminal?** Every command in this guide is designed to be copied
> and pasted directly. Look for the copy button in the top-right corner of each
> code block, or select the text and press Ctrl+C (Cmd+C on macOS).

---

<a id="part-1"></a>

## Part 1 — Your First Decision

**Time**: ~5 minutes · **Goal**: Run a debate, get a recommendation, and export it

By the end of this section, you will have:

- Started an expert debate with a single command
- Received a structured decision framework
- Exported the result as a shareable document

### Step 1: Start a debate

Run this command — Council will design an expert panel from your topic automatically:

```bash
council convene "Should we build our own analytics platform or buy a third-party solution?"
```

Council auto-composes a panel of experts (3 by default; configurable 2–8 via `defaults.maxExperts` or `--max-experts`) tailored to your question. You should
see something like:

```
🏛️ Auto-composing expert panel...
✓ Panel assembled: 3 experts
  • Priya Mehta (CTO) — claude-sonnet-4.5
  • James Whitfield (CFO) — claude-sonnet-4.5
  • Lisa Park (VP Product) — claude-sonnet-4.5

━━━ Round 1 ━━━

[Priya Mehta — CTO]
Building in-house gives us full control over the data pipeline, but we need
to be honest about the cost...

[James Whitfield — CFO]
Three engineers at $180K fully loaded is $270K just in salary for the build
phase. A vendor at $3K/month is $36K/year...

[Lisa Park — VP Product]
Both of you are optimizing for cost, but the real question is speed to insight...

━━━ Synthesis ━━━
The panel splits on build vs. buy but converges on one point: the 6-month
data gap is the real risk...
```

The debate runs for several rounds (default: 4), with each expert bringing their
unique perspective. At the end, Council produces a synthesis that identifies where
experts agree, where they disagree, and what the key decision factors are. When
the debate completes, `council convene` also generates a structured conclusion by
default. This costs one extra premium synthesis request; pass `--no-conclude` to
skip it.

> **💡 Tip**: You can press **Ctrl+C** at any time to stop a debate gracefully.
> The partial transcript is saved and you can resume it later.

> **📝 Panel names**: When you use auto-compose, Council creates a panel with a
> generated name (shown in the output). For `resume`, `conclude`, and `export`,
> you can use **prefix matching** — type just enough characters to uniquely identify
> the panel. Run `council sessions` at any time to see your panel names.

### Step 2: Get a structured recommendation

If you used `--no-conclude`, or you want to regenerate the decision framework
later, run `conclude`:

```bash
council conclude analytics
```

> **Prefix matching**: You don't need to type the full panel name. `analytics`
> will match if it uniquely identifies a panel. If it's ambiguous, Council lists
> the matches so you can pick the right one.

You should see a structured decision document with:

- A clear recommendation
- Key factors that influenced the recommendation
- Risks and mitigations
- Dissenting viewpoints
- Suggested next steps

This is Council's most powerful output — a decision document you can share with
your team, attach to a ticket, or file as an ADR.

### Step 3: Export and share

Export the full debate transcript and conclusion as a markdown file:

```bash
council export analytics
```

This outputs the complete debate history to your terminal. To save it to a file:

```bash
council export analytics --output debate-analytics.md
```

Or export as an Architecture Decision Record:

```bash
council export analytics --format adr --output adr-analytics.md
```

✅ **Checkpoint**: You should now have:

- A completed expert debate with multiple rounds
- A structured decision framework from `council conclude`
- An exported markdown or ADR file

> ⚠️ **Shell quoting**: If your topic contains `$`, backticks, or other special
> characters, wrap it in **single quotes** to prevent your shell from interpreting them:
>
> ```bash
> council convene 'Should we price this at $49/month?'
> ```
>
> On **PowerShell**, use double quotes with backtick escaping:
>
> ```powershell
> council convene "Should we price this at `$49/month?"
> ```
>
> Or sidestep quoting entirely with `--prompt-file <path>` (or `--prompt-file -`
> for stdin), which reads the topic verbatim — no shell involved.
>
> See [Shell Quoting Guide](#shell-quoting) for the full reference.

> 🔧 **Something went wrong?** Run `council doctor` to check your setup.
> It verifies Node.js, config files, database connectivity, and Copilot
> authentication — and tells you exactly what to fix.

---

<a id="part-2"></a>

## Part 2 — Using Built-in Templates

**Time**: ~5 minutes · **Goal**: Find and use the right template for your use case

By the end of this section, you will have:

- Browsed the available templates
- Run a debate using a curated expert panel
- Understood when to use templates vs auto-compose

### Step 1: Browse available templates

See what templates are available:

```bash
council templates
```

You should see the **seventeen** built-in templates with descriptions and the experts each
one includes.

### Step 2: Run a debate with a template

Pick the template that matches your situation:

**For a product decision:**

```bash
council convene "Should we add a freemium tier?" --template startup-validation
```

**For a technical architecture decision:**

```bash
council convene "Should we migrate from REST to GraphQL?" --template architecture-review
```

**For a code review:**

```bash
council convene "Review our authentication middleware" --template code-review
```

**For an incident postmortem:**

```bash
council convene "Database outage on March 15" --template incident-postmortem
```

**For a career decision:**

```bash
council convene "Should I move into engineering management?" --template career-coaching
```

> **Shorthand**: `--panel` is an alias for `--template`. Both work the same way:
>
> ```bash
> council convene "Topic" --panel code-review
> ```

### Step 3: Inspect a template

Want to see exactly which experts a template includes before running it?

```bash
council templates inspect architecture-review
```

### When to use templates vs auto-compose

| Situation                                      | Use               |
| ---------------------------------------------- | ----------------- |
| General question, unsure what experts you need | Auto-compose      |
| You know the domain (code, career, incident)   | Built-in template |
| You want a repeatable panel for recurring work | Custom panel      |

Auto-compose is great for exploration. Templates give you a consistent, curated
panel designed for specific types of decisions.

✅ **Checkpoint**: You should now have:

- Browsed the template library
- Run at least one debate with a built-in template
- Understood the difference between auto-compose and templates

---

<a id="part-3"></a>

## Part 3 — Building Your Expert Panel

**Time**: ~10 minutes · **Goal**: Create reusable experts and panels

By the end of this section, you will have:

- Created custom experts in your library
- Assembled them into a reusable panel
- Run a debate with your panel and concluded it

### Step 1: Create your first expert

Council provides an interactive wizard for creating experts:

```bash
council expert create
```

The wizard asks for:

- **Slug** (short identifier): e.g., `strategist`
- **Display name**: e.g., `Sarah Chen`
- **Role**: e.g., `VP of Strategy focused on market positioning`
- **Expertise areas**: e.g., `competitive analysis, market sizing, go-to-market`

Fill in the details for your first expert. When you're done, Council saves the
expert as a YAML file in your library (`~/Council/experts/strategist.yaml`).

### Step 2: Create more experts

A good panel needs diverse perspectives. Create two or three more experts:

```bash
council expert create
```

Some ideas for a strategy review panel:

- A **devil's advocate** who challenges assumptions
- A **customer researcher** who brings the user's perspective
- A **finance lead** who focuses on unit economics

### Step 3: Verify your expert library

Check that your experts were created:

```bash
council expert list
```

You should see a table listing all your custom experts with their slugs, names,
and roles.

To inspect an expert's full configuration:

```bash
council expert inspect strategist
```

### Step 4: Create a panel

Now assemble your experts into a reusable panel:

```bash
council panel create
```

The wizard asks for:

- **Panel name**: e.g., `strategy-review`
- **Description**: e.g., `Cross-functional strategy review panel`
- **Experts**: Select from your library (you can also add inline experts)

### Step 5: Run a debate with your panel

Use your new panel with `--template`:

```bash
council convene "Should we expand into the European market?" --template strategy-review
```

Your custom experts will debate the topic from their unique perspectives.

### Step 6: Get the decision

Run `conclude` for a structured recommendation:

```bash
council conclude strategy-review
```

### Step 7: Edit an expert (optional)

Need to refine an expert's role or expertise? Edit the YAML directly:

```bash
council expert edit strategist
```

This opens the expert's YAML file in your editor (`$EDITOR` or `$VISUAL`).
Council validates the file when you save — if there's a syntax error, it tells
you exactly what to fix.

✅ **Checkpoint**: You should now have:

- Custom experts in your library (`council expert list` to verify)
- A reusable panel assembled from those experts
- A completed debate using your custom panel
- A structured conclusion

---

<a id="part-4"></a>

## Part 4 — How-to Guides

Goal-oriented recipes for common tasks. Jump to whichever you need.

- [Chat with a panel](#chat-with-a-panel)
- [Direct a message to specific experts](#mention-specific-experts)
- [Trigger an inline deliberation](#inline-deliberation)
- [Manage chat sessions](#manage-chat-sessions)
- [Chat with a single expert (1:1)](#one-on-one-expert-chat)
- [Review documents in chat](#review-documents-in-chat)
- [Ask a quick question](#ask-a-quick-question)
- [Continue a previous debate](#continue-a-previous-debate)
- [Export as an Architecture Decision Record](#export-as-an-adr)
- [Use moderator strategies](#use-moderator-strategies)
- [Manage context in long debates](#manage-context-in-long-debates)
- [Run offline with the mock engine](#run-offline)
- [Customize your defaults](#customize-your-defaults)

<a id="ask-a-quick-question"></a>

### Ask a quick question

Use `council ask` when you want a single expert's perspective without a full
panel debate:

```bash
council ask strategy-review "What are the tradeoffs of event sourcing vs CRUD?"
```

Council asks a specific expert from the panel and gives you a focused answer.
To target a particular expert:

```bash
council ask strategy-review "What are the tradeoffs?" --expert cto
```

This is faster than `convene` when you don't need multiple perspectives.

<a id="have-an-ongoing-conversation"></a>

<a id="chat-with-a-panel"></a>

### Chat with a panel

Use `council chat` with a panel name for an ongoing group conversation where all
experts participate:

```bash
council chat strategy-review
```

Council resolves the panel's experts, indexes any documents in the panel's docs
folder, and drops you into an interactive REPL:

```
📋 Starting group chat with strategy-review (3 experts: Sarah Chen, Marcus Cole, Priya Mehta) — use @name to address specific experts
ℹ Type /exit or /quit to save and end the conversation.

You> What should our Q4 priorities be given the competitive landscape?

[Sarah Chen — VP Strategy]
Given the recent moves by our top two competitors, I'd focus on three things...

[Marcus Cole — Devil's Advocate]
Before we lock in priorities, let's challenge the assumption that we need to
react to competitors at all...

[Priya Mehta — Customer Research]
I'd reframe this around what our customers are actually asking for...

You>
```

Every expert responds to each message. The conversation persists — exit with
`/exit` or `/quit` and pick up where you left off next time you run the same
command.

> **💡 Tip**: Press **Ctrl+C** to abort an expert mid-response. The partial
> output is saved and you return to the `You>` prompt.

<a id="mention-specific-experts"></a>

### Direct a message to specific experts

In panel chat, prefix your message with `@slug` to route it to one or more
specific experts:

```
You> @strategist What's our biggest competitive moat?

[Sarah Chen — VP Strategy]
Our data network effects are the primary moat...
```

You can mention multiple experts:

```
You> @strategist @devils-advocate Is our pricing strategy sustainable?

[Sarah Chen — VP Strategy]
The current pricing model aligns with our value metric...

[Marcus Cole — Devil's Advocate]
I'd push back on that. Three of our five largest accounts have asked for
volume discounts...
```

Only the mentioned experts respond — others stay silent for that turn.

> **📝 Note**: Mentions must appear at the **start** of your message.
> `@strategist What do you think?` works. `What do you think @strategist?`
> is treated as a general message to everyone.

> **💡 Tip**: If you mention a slug that isn't in the panel, Council shows an
> error listing the available experts — no guessing required.

<a id="inline-deliberation"></a>

### Trigger an inline deliberation

When a chat topic needs formal debate treatment, use `@convene` to trigger a
structured 4-phase deliberation without leaving the chat:

```
You> @convene Should we raise prices by 20%?

⚙ Starting structured deliberation: "Should we raise prices by 20%?"...

━━━ Opening Statements ━━━
[Sarah Chen — VP Strategy]
A 20% increase signals confidence in our value...

[Marcus Cole — Devil's Advocate]
That's aggressive given current churn rates...

━━━ Cross-Examination ━━━
...

━━━ Rebuttals ━━━
...

━━━ Synthesis ━━━
The panel agrees that a price increase is warranted but splits on magnitude...

You>
```

The deliberation runs through opening statements, cross-examination, rebuttals,
and synthesis — then returns you to the chat prompt. The entire deliberation is
saved in your chat history.

> **📝 Note**: `@convene` requires a topic. `@convene` alone (with no topic)
> shows a usage hint.

<a id="manage-chat-sessions"></a>

### Manage chat sessions

Council persists your conversations automatically. Here's how to manage them:

**Start fresh** — archive the current conversation and begin a new one:

```bash
council chat strategy-review --new
```

**List all conversations** — see every chat session across all experts and panels:

```bash
council chat --list
```

**View archived conversations** — see past conversations for a specific target:

```bash
council chat strategy-review --history
```

**End a conversation** — type `/exit` or `/quit` in the chat prompt. Your
conversation is saved and you can resume it anytime by running the same
`council chat` command.

<a id="one-on-one-expert-chat"></a>

### Chat with a single expert (1:1)

For a focused conversation with one expert, pass an expert slug instead of a
panel name:

```bash
council chat cto
```

This starts a direct 1:1 conversation. There are no `@mentions` or `@convene`
in 1:1 mode — every message goes to your expert and every response comes from
them.

1:1 chat is especially powerful with [persona experts](#part-5) trained on your
documents. The expert draws on its reference material to give document-informed
responses.

```bash
council chat cfo
```

```
You> What's our payback period on the new data platform?

[Sarah Chen — CFO]
Based on the financial projections in our Q3 analysis, the payback period
is approximately 14 months, assuming we hit the adoption targets in the
rollout plan...
```

> **💡 Tip**: The same session management flags work for 1:1 chat —
> `--new`, `--list`, and `--history` all apply.

<a id="review-documents-in-chat"></a>

### Review documents in chat

Council can pull relevant content from your documents into chat conversations
using RAG (retrieval-augmented generation). This lets you ask experts to review,
critique, or build on your existing work.

#### Step 1: Place documents in the docs folder

For **panel chat**, place files in the panel's docs folder:

```
~/Council/panels/strategy-review/docs/
  ├── market-analysis.md
  ├── product-brief.txt
  └── competitive-landscape.html
```

You can also link external folders:

```bash
council panel docs link strategy-review --path ./research/
```

For **1:1 expert chat**, document retrieval is available for persona experts
created with `council expert create --persona` and trained with
`council expert train`; generic experts ignore expert documents. Place files in
that persona expert's docs folder:

```
~/Council/experts/cfo/docs/
  ├── q3-financials.md
  └── budget-proposal.txt
```

Supported formats (default): `.md`, `.txt`, `.html`, `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.xls`, `.csv`, `.tsv`, `.rtf`, `.odt`, `.ods`, `.odp`. Run `council docs formats` for the full list.

#### Step 2: Start a chat

Council indexes new and changed documents automatically when you start a chat:

```bash
council chat strategy-review
```

```
ℹ Indexed 3 panel document(s) (0 unchanged, 0 failed).
📋 Starting group chat with strategy-review (3 experts)...
```

#### Step 3: Ask for a review

Reference your documents naturally — Council retrieves relevant snippets
automatically:

```
You> Review the product brief and tell me what's weak.

[Sarah Chen — VP Strategy]
The brief covers the target market well, but I see three gaps. First,
the competitive positioning section on page 2 doesn't address the pricing
pressure from FreshDesk's new tier...
```

You can ask for rewrites too:

```
You> Rewrite the executive summary to be more compelling for our board.

[Sarah Chen — VP Strategy]
Here's a revised executive summary:

"In Q3, our platform processed 2.4M transactions — a 47% increase that
outpaced the market by 3x. This growth validates our bet on..."
```

> **📝 Note**: Experts produce rewritten text **in the chat response**. They
> cannot write files back to disk. Copy the output manually or use
> `council export` to capture the full conversation.
> See [issue #900](https://github.com/pedrofuentes/Council/issues/900) for
> the planned file-writing feature.

#### Step 4: Synthesize across multiple documents

When you have several related documents, ask questions that require connecting
insights across them:

```
You> Based on the market analysis and the product brief, what's missing
from our go-to-market plan?

[Marcus Cole — Devil's Advocate]
The market analysis identifies three underserved segments, but the product
brief only targets one of them. The go-to-market plan doesn't explain why
we're leaving the other two on the table...
```

#### Step 5: Keep documents current

When you update a document in the docs folder, Council re-indexes automatically
the next time you start a chat:

```bash
council chat strategy-review
```

```
ℹ Indexed 1 panel document(s) (2 unchanged, 0 failed).
```

Council detects changed files by checksum — only modified documents are
reprocessed. You don't need `--new` just to pick up document changes; use
`--new` only when you want to archive the current conversation and start fresh.

> **💡 Tip**: If you have multiple versions of the same document in the docs
> folder, consider removing outdated versions to keep retrieval focused on
> the latest content.

<a id="continue-a-previous-debate"></a>

### Continue a previous debate

To review a previous debate's transcript:

```bash
council resume strategy-review
```

To continue the debate with a follow-up question:

```bash
council resume strategy-review --prompt "What about the regulatory risk in the EU?"
```

> **Prefix matching**: Type just enough of the panel name to uniquely identify it.
> `council resume strat` works if `strategy-review` is the only panel starting
> with "strat."

To see all your past sessions:

```bash
council sessions
```

<a id="export-as-an-adr"></a>

### Export as an Architecture Decision Record

ADRs (Architecture Decision Records) are short documents that capture technical
decisions, the options considered, and why one was chosen. Council can export any
debate directly in ADR format:

```bash
council export strategy-review --format adr --output docs/adr/0007-european-expansion.md
```

The ADR includes:

- **Title** and **date**
- **Status** (proposed/accepted/superseded)
- **Context** (the question debated)
- **Decision** (the recommendation)
- **Consequences** (tradeoffs and risks)

This bridges the gap between discussion and engineering documentation — you can
debate in Council and commit the result alongside your code.

<a id="use-moderator-strategies"></a>

### Use moderator strategies

By default, Council uses **round-robin** moderation — each expert speaks in turn.
You can change this to get different dynamics:

**Consensus check** — experts work toward agreement:

```bash
council convene "Should we adopt Kubernetes?" --template architecture-review --strategy consensus-check
```

**Devil's advocate** — one expert is assigned to challenge everything:

```bash
council convene "Should we ship the MVP?" --template code-review --strategy devils-advocate
```

You can pin a specific expert as the contrarian:

```bash
council convene "Ship now or wait?" --template code-review --strategy devils-advocate:senior
```

**Structured mode** — a choreographed 4-phase debate (opening → cross-examination →
rebuttal → synthesis):

```bash
council convene "Should we go public?" --template architecture-review --mode structured
```

<a id="manage-context-in-long-debates"></a>

### Manage context in long debates

For debates with many rounds, you can control how much prior context each expert
sees. This prevents responses from becoming repetitive and manages token usage:

**Recent context only** — experts see only the most recent turns:

```bash
council convene "Long architectural debate" --template architecture-review \
  --max-rounds 10 --context-scope recent
```

**Same-round context** — experts only see other responses from the current round:

```bash
council convene "Long debate" --template architecture-review \
  --max-rounds 10 --context-scope same-round
```

**Rolling summary** — prepend a summary after a specified round:

```bash
council convene "Long debate" --template architecture-review \
  --max-rounds 10 --summarize-after 3
```

To inspect what Council remembers about a panel:

```bash
council memory list
```

```bash
council memory inspect strategy-review
```

To view a specific expert's memory and provenance:

```bash
council memory inspect strategy-review --expert cto
```

To clear debate history while keeping the panel configuration:

```bash
council memory reset strategy-review --yes
```

<a id="run-offline"></a>

### Run offline with the mock engine

Council includes a deterministic mock engine for testing, demos, and offline use:

```bash
council convene "Test topic" --template code-review --engine mock
```

Mock responses are clearly labeled with `!! [MOCK ENGINE]` banners so you never
confuse them with real output.

The mock engine is also useful for:

- Testing panel configurations before running live
- CI/CD pipelines (see [Part 6](#part-6))
- Demos and screenshots
- Working without network access

<a id="customize-your-defaults"></a>

### Customize your defaults

View your current configuration:

```bash
council config show
```

This displays all settings with their current values and where each value comes
from (default, config file, or environment variable).

Change a default:

```bash
council config set defaults.model gpt-4.1
council config set defaults.maxRounds 6
council config set defaults.maxExperts 5
```

Open the config file in your editor for more complex changes:

```bash
council config edit
```

See the [Configuration Reference](#configuration-reference) for all available options.

---

<a id="part-5"></a>

## Part 5 — Creating a Persona Expert

**Time**: ~15 minutes · **Goal**: Create an expert trained on your documents · **Level**: Advanced

> This section is optional. You can use Council effectively with generic experts
> and built-in templates. Persona experts add deeper fidelity when you need an
> expert that thinks and talks like a specific person or reflects specific source material.

By the end of this section, you will have:

- Understood the difference between generic and persona experts
- Created a persona expert
- Trained it with reference documents
- Verified it stays in character
- Used it alongside generic experts in a panel

### Generic vs persona experts

| Aspect           | Generic expert                 | Persona expert                      |
| ---------------- | ------------------------------ | ----------------------------------- |
| **Created with** | `council expert create`        | `council expert create --persona`   |
| **Shaped by**    | Role description and expertise | Role + reference documents          |
| **Training**     | None needed                    | Trained on docs you provide         |
| **Best for**     | Standard advisory roles        | Mimicking a specific viewpoint      |
| **Example**      | "CTO focused on scalability"   | "Our CTO, based on their past RFCs" |

A generic expert follows its role description. A persona expert also draws on a
corpus of reference documents — past writings, frameworks, decision records — to
develop a richer communication style and decision patterns.

### Step 1: Create a persona expert

```bash
council expert create --persona
```

The wizard is the same as for generic experts, but Council also provisions a
documents folder at `~/Council/experts/<slug>/docs/`.

Example: create a CFO persona named `cfo`:

- **Slug**: `cfo`
- **Display name**: `Sarah Chen`
- **Role**: `CFO focused on financial modeling and risk assessment`

### Step 2: Provide reference documents

Place reference documents in the expert's docs folder:

```
~/Council/experts/cfo/docs/
  ├── financial-framework.md
  ├── quarterly-analysis.txt
  └── risk-assessment-template.html
```

Supported formats (default): `.md`, `.txt`, `.html`, `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.xls`, `.csv`, `.tsv`, `.rtf`, `.odt`, `.ods`, `.odp`. Run `council docs formats` for the full list.

These documents shape how the persona thinks and communicates. Good reference
material includes:

- Past decision documents or memos
- Frameworks the person uses
- Writing samples that show their communication style
- Domain-specific terminology or methodology

### Step 3: Train the persona

Train the expert to analyze the documents and build a persona profile:

```bash
council expert train cfo
```

You can also supply documents directly via flags instead of the docs folder:

```bash
council expert train cfo --file path/to/framework.md
```

Or from a URL:

```bash
council expert train cfo --url https://example.com/financial-model.md
```

Training analyzes the documents and produces a structured persona profile
covering communication style, decision patterns, biases, vocabulary, and
epistemic stance. This profile is injected into the expert's system prompt.

### Step 4: Test the persona

Start a conversation to verify the persona reflects the reference material:

```bash
council chat cfo
```

Ask questions related to the documents you provided. The expert should respond
using the frameworks, vocabulary, and decision patterns from the reference material.

You can also ask the expert to review or critique documents. Place a draft in the
expert's docs folder and ask for feedback — the expert's responses draw on both
its persona profile and the document content. See
[Review documents in chat](#review-documents-in-chat) for the full workflow.

Try an off-topic question to test fidelity. A well-trained CFO persona asked
"Should we use Rust or Go?" should answer through a financial lens — comparing
hiring costs, training investment, and opportunity cost — rather than giving a
generic technical comparison.

### Step 5: Retrain after updates

When you add, modify, or remove documents from the docs folder, retrain the persona:

```bash
council expert train cfo --retrain
```

The `--retrain` flag forces a full rebuild of the persona profile. Without it,
Council only processes new or changed documents.

> **Recency weighting**: Newer documents automatically carry more weight than
> older ones. An updated RFC takes priority over a superseded version without
> you needing to delete the old file.

### Step 6: Use the persona in a panel

Persona experts work alongside generic experts in panels. Create a panel that
mixes both types:

```bash
council panel create
```

Add your `cfo` persona alongside generic experts like `strategist` and
`devils-advocate`. The persona expert contributes its document-informed
perspective while generic experts bring their role-based viewpoint.

```bash
council convene "Should we pursue a Series B or bootstrap?" --template strategy-review
```

✅ **Checkpoint**: You should now have:

- A persona expert trained on your reference documents
- Verified that it responds in character, even on off-topic questions
- Used it in a panel debate alongside generic experts

---

<a id="part-6"></a>

## Part 6 — Power User Patterns

> _For engineers and automation._ This section covers scripting, CI/CD integration,
> and advanced configuration. You don't need any of this for everyday use.

### Scripting with JSON output

Several Council commands support `--format json` for machine-readable output:

```bash
council convene "Topic" --template code-review --format json | jq .
```

For `council convene --format json`, each line is an NDJSON event. After a
completed debate, the final line is a conclusion event emitted after
`{"kind":"debate.end", ...}`:

```text
{"kind":"conclusion","conclusion":{...}}
```

The `conclusion` object matches `council conclude --format json`: `panelName`,
`topic`, `debateId`, `startedAt`, `consensus`, `tensions`, `decisionMatrix`,
`recommendation`, `confidence`, and optional `warnings`.

Pass `--no-conclude` to omit this final conclusion event and avoid the extra
premium synthesis request.

```bash
council expert list --format json
```

JSON output goes to **stdout**. Progress messages, banners, and logs go to
**stderr**. This includes `council convene` auto-compose setup progress and
`council ask` answer-preparation progress, so you can safely pipe JSON to `jq`
or redirect to a file without capturing noise:

```bash
council convene "Topic" --template code-review --format json > debate.ndjson 2>/dev/null
```

Council uses specific exit codes for scripting (see [Exit Codes](#exit-codes)):

- `0` = success, `1` = user error, `2` = auth error, `3` = network, `4` = internal

```bash
if council conclude my-panel --format json > decision.json 2>/dev/null; then
  echo "Decision exported successfully"
else
  echo "Council failed with exit code $?" >&2
fi
```

Use `--yes` to skip interactive confirmations in scripts:

```bash
council memory reset my-panel --yes
council expert delete old-expert --yes
council panel delete old-panel --yes
```

### Composing commands

Chain Council commands for end-to-end workflows:

**Debate → Conclude → Export as ADR:**

```bash
council convene "Should we adopt event sourcing?" --template architecture-review
council conclude architecture-review
council export architecture-review --format adr --output docs/adr/0012-event-sourcing.md
```

**Quick review with mock engine:**

```bash
council convene "Test my panel configuration" --template my-panel --engine mock
council conclude my-panel --engine mock
```

### CI/CD integration

Use Council in automated pipelines with these environment variables and flags:

```bash
export COUNCIL_DATA_HOME="$PWD/.council-ci"
export TERM=dumb
export NO_COLOR=1

council convene "Evaluate migration plan" \
  --template architecture-review \
  --engine mock \
  --format json \
  --yes
```

Key flags for CI:

- `--engine mock` — deterministic, no network calls
- `--format json` — machine-parseable output
- `--yes` — skip interactive confirmations
- `--quiet` — suppress informational stderr messages, including `convene` /
  `ask` setup progress
- `COUNCIL_DATA_HOME` — isolate CI data from your user data
- `TERM=dumb` / `NO_COLOR=1` — disable terminal formatting; non-TTY output is
  plain text with no spinner animation
- `COUNCIL_ASCII=1` — use ASCII instead of Unicode symbols

<a id="shell-quoting"></a>

### Shell quoting guide

The `$` sign and backticks are the most common source of surprises. Here's how
to handle them in different shells:

**Bash / Zsh:**

```bash
# Use single quotes to prevent all interpolation
council convene 'Should we price at $49/month?'

# Or escape individual characters
council convene "Should we price at \$49/month?"
```

**PowerShell:**

```powershell
# Use backtick to escape $
council convene "Should we price at `$49/month?"

# Or use single quotes (no interpolation in PowerShell single quotes)
council convene 'Should we price at $49/month?'

# Multi-line prompts with here-strings
council convene @"
Compare these options:
1. Keep current architecture
2. Split into microservices
"@
```

**General rules:**
| Character | Bash/Zsh | PowerShell |
| --------- | ----------------- | ------------------ |
| `$` | `'...'` or `\$` | `` `$ `` or `'...'` |
| Backtick | `'...'` or `` \` ``| Already escaped |
| `"` | `\"` or `'...'` | `` `" `` or `'...'` |

**Bulletproof option — `--prompt-file`:** to sidestep shell quoting entirely,
read the topic/question VERBATIM from a file or stdin. Nothing passes through the
shell, so `$180K`, backticks, and `$variables` survive exactly as written. This
works for both `convene` and `ask`:

```bash
# From a file
council convene --prompt-file topic.txt

# From stdin (use - as the path)
echo 'We have $180K in runway — raise or cut?' | council convene --prompt-file -
council ask my-panel --prompt-file question.txt
```

`--prompt-file` is mutually exclusive with the positional `<topic>`/`<question>`
argument. When a shell-argument topic looks like it may have been mangled by the
shell (for example, a `$amount` that expanded to nothing), Council echoes what it
received and asks you to confirm before running — so a silently corrupted prompt
never reaches the panel unnoticed.

<a id="exit-codes"></a>

### Exit codes

| Code | Meaning        | Example                                   |
| ---- | -------------- | ----------------------------------------- |
| `0`  | Success        | Command completed normally                |
| `1`  | User error     | Missing argument, invalid flag, bad input |
| `2`  | Auth error     | Copilot authentication failed or expired  |
| `3`  | Network error  | API unreachable, timeout                  |
| `4`  | Internal error | Unexpected failure (please report a bug)  |

### Environment variables

| Variable             | Purpose                                                                     | Example                             |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| `COUNCIL_HOME`       | Config directory (default: `~/.council`)                                    | `COUNCIL_HOME=/opt/council`         |
| `COUNCIL_DATA_HOME`  | Data directory (database, experts, panels)                                  | `COUNCIL_DATA_HOME=/tmp/council-ci` |
| `COUNCIL_ASCII`      | Force ASCII symbols (no Unicode)                                            | `COUNCIL_ASCII=1`                   |
| `NO_COLOR`           | Disable color output                                                        | `NO_COLOR=1`                        |
| `TERM`               | Set to `dumb` to disable all terminal effects                               | `TERM=dumb`                         |
| `EDITOR` / `VISUAL`  | Editor for `config edit` and `expert edit`                                  | `EDITOR=vim`                        |
| `CI`                 | Indicates CI environment (disables interactivity, suppresses update notice) | `CI=true`                           |
| `NO_UPDATE_NOTIFIER` | Suppress the "update available" startup notice                              | `NO_UPDATE_NOTIFIER=1`              |
| `ACCESSIBILITY`      | Enable accessibility features                                               | `ACCESSIBILITY=1`                   |

### Custom expert YAML

Experts are stored as YAML files in `~/Council/experts/<slug>.yaml`:

```yaml
slug: strategist
displayName: "Sarah Chen"
role: "VP of Strategy focused on market positioning and competitive analysis"
expertise:
  weightedEvidence:
    - "Competitive intelligence and market sizing"
    - "Go-to-market strategy"
    - "Product-market fit assessment"
  referenceCases:
    - "Led market entry for 3 SaaS products"
    - "Managed pricing strategy across B2B and B2C"
  notExpertIn:
    - "Deep technical architecture"
    - "Security engineering"
epistemicStance: >
  You believe data-driven decisions beat intuition, but you also know that
  market timing often matters more than perfect analysis. You push for
  speed-to-learning over exhaustive research.
```

### Custom panel YAML

Panels live in `~/Council/panels/<name>.yaml`:

```yaml
name: strategy-review
description: "Cross-functional strategy review for major product decisions"
experts:
  # Reference library experts by slug:
  - strategist
  - devils-advocate
  - customer-researcher
  # Or define inline experts for this panel only:
  - slug: finance-lead
    displayName: "Finance Lead"
    role: "CFO perspective on unit economics and runway"
    expertise:
      weightedEvidence:
        - "Financial modeling"
        - "SaaS metrics (ARR, LTV, CAC)"
```

Slug references are resolved against your expert library. Unresolved slugs
produce a clear error telling you to either create the expert or define it inline.

### Panel document corpus

Panels can have shared reference documents that all experts in the panel can access:

```bash
council panel docs strategy-review                              # list docs
council panel docs link strategy-review --path ./research/      # link a folder
council panel docs unlink strategy-review --path ./research/    # unlink
```

---

<a id="part-7"></a>

## Part 7 — Quick Reference

### All commands

| Command                     | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `council convene`           | Start a new expert debate                                     |
| `council ask`               | Quick one-shot question to a single expert                    |
| `council chat`              | Ongoing conversation with an expert or panel                  |
| `council resume`            | View or continue a previous debate                            |
| `council conclude`          | Generate a structured decision framework                      |
| `council export`            | Export debate transcript (markdown or ADR)                    |
| `council expert create`     | Create a new expert (interactive wizard)                      |
| `council expert list`       | List all experts in your library                              |
| `council expert inspect`    | View expert details and panel memberships                     |
| `council expert edit`       | Edit expert YAML in your editor                               |
| `council expert delete`     | Remove an expert from your library                            |
| `council expert train`      | Train a persona expert on documents                           |
| `council expert docs`       | Manage a persona expert's document folder                     |
| `council panel create`      | Create a new panel (interactive wizard)                       |
| `council panel list`        | List all panels                                               |
| `council panel inspect`     | View panel details and expert roster                          |
| `council panel edit`        | Edit panel YAML in your editor                                |
| `council panel save`        | Promote a convene session into a library panel                |
| `council panel delete`      | Remove a panel                                                |
| `council panel docs`        | Manage panel's shared document corpus                         |
| `council docs`              | Document utilities (`formats`, `review`, `extract`, `doctor`) |
| `council models`            | List available Copilot models                                 |
| `council templates`         | List built-in templates                                       |
| `council templates inspect` | View template details                                         |
| `council sessions`          | List past debate sessions                                     |
| `council sessions cancel`   | Cancel an in-progress session                                 |
| `council sessions delete`   | Delete a saved session                                        |
| `council memory list`       | Summary of stored memories by panel                           |
| `council memory inspect`    | Detailed memory view for a panel or expert                    |
| `council memory reset`      | Clear debate history (keeps panel config)                     |
| `council doctor`            | Check setup and diagnose issues                               |
| `council config show`       | Display current configuration with sources                    |
| `council config path`       | Print config file location                                    |
| `council config edit`       | Open config in your editor                                    |
| `council config set`        | Change a configuration value                                  |

Aliases: `experts`, `panels`, and `history` are aliases for `expert`, `panel`, and `sessions`.

### `council convene` options

| Flag                    | Description                                                                  | Default             |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------- |
| `--template <name>`     | Use a built-in or custom panel                                               | (auto-compose)      |
| `-p, --panel <name>`    | Alias for `--template`                                                       | (auto-compose)      |
| `--prompt-file <path>`  | Read topic verbatim from file or `-` for stdin                               | (none)              |
| `--model`               | Override the AI model                                                        | `claude-sonnet-4.5` |
| `--engine`              | Engine to use (`copilot` or `mock`)                                          | `copilot`           |
| `--max-rounds`          | Number of deliberation rounds (1–20)                                         | `4`                 |
| `--max-experts`         | Max experts for auto-compose (2–8)                                           | `3`                 |
| `--strategy`            | Moderator strategy                                                           | `round-robin`       |
| `--mode`                | Debate mode (`freeform` or `structured`)                                     | `freeform`          |
| `--context-scope`       | Context window management                                                    | `all`               |
| `--summarize-after`     | Start rolling summaries after round N                                        | (disabled)          |
| `--format`              | Output format (`auto`, `json`, or `plain`)                                   | `auto`              |
| `--no-conclude`         | Skip automatic conclusion synthesis after a completed debate                 | (auto-conclude)     |
| `--quiet`               | Suppress informational messages                                              | `false`             |
| `--yes`                 | Skip confirmations                                                           | `false`             |
| `--verbose`             | Extra diagnostic output                                                      | `false`             |
| `--max-words`           | Soft per-response word budget (50–2000); structured mode scales it per phase | `250`               |
| `--experts`             | Expert slugs from the library, space- or comma-separated, repeatable         | (none)              |
| `--human`               | Add a human participant (repeatable)                                         | (none)              |
| `--heuristic-summaries` | Local summarizer for offline use                                             | `false`             |
| `--heuristic-memory`    | Skip post-debate LLM extraction                                              | `false`             |

### `council chat` options

| Flag        | Description                                | Default       |
| ----------- | ------------------------------------------ | ------------- |
| `--engine`  | Engine to use (`copilot` or `mock`)        | (from config) |
| `--new`     | Archive active conversation, start fresh   | `false`       |
| `--list`    | List all chat conversations and exit       | `false`       |
| `--history` | Show archived conversations for the target | `false`       |

**In-chat directives** (type these at the `You>` prompt during panel chat):

| Directive          | Effect                                          |
| ------------------ | ----------------------------------------------- |
| `@slug message`    | Route message to specific expert(s)             |
| `@convene topic`   | Trigger inline structured 4-phase deliberation  |
| `/exit` or `/quit` | Save conversation and exit                      |
| **Ctrl+C**         | Abort current expert response, return to prompt |

<a id="configuration-reference"></a>

### Configuration options

Set these with `council config set <key> <value>`:

| Key                                       | Description                                                | Default                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `defaults.model`                          | Default AI model                                           | `claude-sonnet-4.5`                                                                       |
| `defaults.engine`                         | Default engine                                             | `copilot`                                                                                 |
| `defaults.maxRounds`                      | Default deliberation rounds                                | `4`                                                                                       |
| `defaults.maxExperts`                     | Default max experts (auto-compose)                         | `3`                                                                                       |
| `defaults.maxWordsPerResponse`            | Default soft word budget; structured mode scales per phase | `250`                                                                                     |
| `documents.aiExtraction`                  | AI-assisted document extraction                            | `off` (`off`, `ask`, `auto`)                                                              |
| `documents.aiExtractionAllowedExtensions` | Extensions allowed for AI extraction                       | `[]`                                                                                      |
| `documents.maxFileSizeMB`                 | Maximum document file size                                 | `50`                                                                                      |
| `conclude.maxTranscriptChars`             | Max transcript chars for conclusion                        | `50000`                                                                                   |
| `qualityGate.mode`                        | Anti-sycophancy quality-gate mode (`regenerate` incurs up to `maxRegenerations` extra premium requests per flagged response) | `warn` (`off`, `warn`, `regenerate`)                                                      |
| `qualityGate.maxRegenerations`            | Max regeneration attempts when mode is `regenerate`        | `1` (0–3)                                                                                 |
| `expert.recencyHalfLifeDays`              | Document recency half-life                                 | `90`                                                                                      |
| `expert.supportedFormats`                 | Supported doc formats                                      | 14 extensions (`md, txt, html, pdf, csv, tsv, rtf, docx, pptx, xlsx, xls, odt, ods, odp`) |
| `chat.recentTurnCount`                    | Recent turns to include                                    | `10`                                                                                      |
| `chat.summaryMaxWords`                    | Summary length limit                                       | `500`                                                                                     |
| `chat.longConversationWarning`            | Warn on long conversations                                 | `500`                                                                                     |
| `telemetry.enabled`                       | Enable telemetry                                           | `false`                                                                                   |
| `paths.dataHome`                          | Data directory path                                        | `~/Council`                                                                               |

### Glossary

| Term               | Definition                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **Auto-compose**   | Council automatically designs an expert panel from your topic — no template or setup needed |
| **Panel**          | A saved group of experts that you can reuse across debates                                  |
| **Expert**         | An AI participant with a defined role, expertise areas, and perspective                     |
| **Persona expert** | An expert trained on reference documents to mimic a specific person's viewpoint             |
| **Generic expert** | A standard expert defined by role description only (no document training)                   |
| **Template**       | A built-in panel configuration (e.g., `architecture-review`, `code-review`)                 |
| **Debate**         | A multi-round discussion where experts respond to a topic from different perspectives       |
| **Round**          | One cycle where each expert provides a response                                             |
| **Synthesis**      | Council's summary identifying agreements, disagreements, and key factors                    |
| **Conclusion**     | A structured decision framework generated by `council conclude`                             |
| **ADR**            | Architecture Decision Record — a short document capturing a technical decision              |
| **Slug**           | A short identifier for an expert or panel (e.g., `cto`, `strategy-review`)                  |
| **Mock engine**    | A deterministic, offline engine for testing and demos (`--engine mock`)                     |
| **Fidelity**       | How accurately a persona expert reflects its reference documents                            |
| **Strategy**       | The moderator pattern used during debate (round-robin, consensus-check, devils-advocate)    |
| **Panel chat**     | Group conversation with all experts in a panel — supports `@mentions` and `@convene`        |
| **@mention**       | Prefix (`@slug`) that routes a message to specific expert(s) in panel chat                  |
| **@convene**       | Directive that triggers an inline structured 4-phase deliberation within panel chat         |
| **RAG**            | Retrieval-augmented generation — automatic surfacing of relevant document snippets in chat  |

### Troubleshooting

**"command not found: council"**
Council isn't installed globally. Run:

```bash
npm install -g @council-ai/cli
```

**"Did you mean…?" suggestion**
Council shows helpful suggestions for typos. If you see this, check the
spelling of the command or subcommand.

**Debate produces generic responses**

- Try a more specific prompt with concrete details (numbers, constraints, context)
- Use a template that matches your domain
- Increase `--max-rounds` for deeper exploration
- Try `--strategy devils-advocate` to force disagreement

**Shell eats special characters in your prompt**
See [Shell Quoting Guide](#shell-quoting). Use single quotes in bash/zsh.

**Expert or panel "not found"**

- Check the name with `council expert list` or `council panel list`
- Use the full slug — prefix matching only works for `resume`, `export`, and `conclude`

**`council doctor` reports issues**
Follow the suggested fixes. Common issues:

- Node.js version too old (need 22+)
- Config file syntax error (run `council config edit` to fix)
- Database locked (close other Council processes)
- Copilot authentication expired (re-authenticate in your editor)

**Mock engine gives "unparsable JSON" during training**
This is a known limitation. Use the real engine for `council expert train`:

```bash
council expert train cfo --retrain
```

---

## What's next?

- **Explore templates**: Run `council templates` and try each one
- **Build your library**: Create experts that reflect your team's perspectives
- **Chat with your panel**: Use `council chat` for ongoing conversations and document review
- **Train personas**: Add reference documents and train persona experts for deeper fidelity
- **Integrate into your workflow**: Export decisions as ADRs and commit them with your code
- **Automate**: Use Council in CI/CD for automated architecture reviews

Have feedback? [Open an issue](https://github.com/pedrofuentes/Council/issues) or
contribute to the project.
