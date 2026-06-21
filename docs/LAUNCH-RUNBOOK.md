# Launch Runbook — Council

**For:** Maintainer executing Council's public launch
**Purpose:** Checklist-driven sequence for taking Council from published package to active public project
**Status:** Pre-launch — Council v0.4.0 is published; growth phase (Phase 8) not started

> This is **internal ops documentation** for the maintainer. For contributor-facing docs, see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Quick Reference

| Stage                     | Goal                                  | Prerequisites                 | Success Signal                          | Abort Signal                  |
| ------------------------- | ------------------------------------- | ----------------------------- | --------------------------------------- | ----------------------------- |
| **Pre-launch**            | Package is installable and documented | All items in §1 checked       | `council doctor` green on clean machine | Doctor fails; docs incomplete |
| **Stage 1: Friends**      | Feedback from 10–20 friendly users    | Pre-launch complete           | 5+ actionable issues/testimonials       | No engagement after 1 week    |
| **Stage 2: Lists**        | Discoverability via curated lists     | Stage 1 feedback incorporated | 2+ PRs merged to awesome-lists          | PRs ignored/rejected          |
| **Stage 3: Show HN**      | Hacker News visibility                | Real user feedback exists     | 20+ points, 5+ comments                 | <5 points after 2 hours       |
| **Stage 4: Targeted**     | Niche community traction              | Show HN posted                | 50+ total GitHub stars                  | Negative sentiment            |
| **Stage 5: Product Hunt** | Broader visibility                    | 100+ stars, testimonials      | Top 10 daily ranking                    | <20 upvotes                   |

---

## 1. Pre-Launch Readiness Checklist

**Goal:** Ensure Council is discoverable, installable, and working before any external promotion.

### Package & Installation

- [x] **npm package published** — `@council-ai/cli` at v0.4.0+ on npmjs.com with provenance
- [ ] **[HUMAN]** Verify `npm i -g @council-ai/cli` installs cleanly on macOS, Linux, Windows (or document Windows unsupported if true)
- [x] `council doctor` implemented — checks Node.js 24+, SQLite, Copilot SDK, disk space, and online model connectivity
- [ ] **[HUMAN]** Run `council doctor` on a clean machine (no prior Council install) — all checks green
- [x] `council demo` implemented — zero-setup offline showcase debate (no login/API keys required)
- [ ] **[HUMAN]** Verify `council demo` runs successfully on a clean machine

### Documentation & Content

- [x] **README.md** — First-screen pitch (what Council is, why it matters, quick start) is clear
- [x] **Docs site exists** — Structured docs under `packages/site/src/content/docs/` (tutorials, how-to, reference, explanation)
- [ ] **[HUMAN]** Publish docs site to GitHub Pages at `https://pedrofuentes.github.io/council` (or custom domain)
  - Enable Pages in repo Settings → Pages → Source: GitHub Actions or gh-pages branch
  - Verify site builds and is accessible
- [x] **Example transcripts** — Real Council session examples exist (check `docs/examples/` or create 2–3 representative transcripts)
- [ ] **[HUMAN]** Create comparison page — Council vs. ChatGPT/Claude/AutoGPT/CrewAI (use `docs/launch/comparison-copy.md` as base)
- [ ] **[HUMAN]** Create use-case page — Specific scenarios where Council excels (use `docs/launch/use-case-copy.md` as base)

### Repository Presentation

- [x] **LICENSE** — MIT license present
- [x] **SECURITY.md** — Vulnerability reporting policy
- [x] **PRIVACY.md** — Data handling policy
- [x] **SUPPORT.md** — Support channels
- [ ] **[HUMAN]** Set GitHub repo "About" section:
  - Description: "Persistent AI expert panels for deliberation and decision-making"
  - Website: (docs site URL)
  - Topics: `ai`, `cli`, `multi-agent`, `deliberation`, `github-copilot`, `decision-making`, `ai-debate`, `terminal`, `developer-tools` (10 max)
- [ ] **[HUMAN]** Set social preview image (repo Settings → Social preview → Upload image 1280×640)
- [ ] **[HUMAN]** Enable GitHub Discussions (Settings → Features → Discussions)
- [ ] **[HUMAN]** Verify issue templates work (`.github/ISSUE_TEMPLATE/`) — test creating a bug report and feature request

### Pre-Launch Smoke Test (Clean Machine)

Run this sequence on a fresh environment (new VM, friend's laptop, GitHub Codespaces):

```bash
npm install -g @council-ai/cli
council --version        # Should show 0.4.0+
council doctor           # All checks green
council demo             # Runs to completion, shows debate transcript
council convene "Should I learn Rust or Go?" --help  # Shows usage (don't run full debate unless Copilot configured)
```

All steps succeed → proceed. Any failure → fix before launch.

---

## 2. Staged Launch Sequence

### Stage 1: Friendly Users (10–20 people)

**When:** After Pre-Launch Checklist complete
**Goal:** Validate installation, gather feedback, find rough edges

#### Who to Invite

- Technical friends who use CLI tools and have GitHub Copilot
- Twitter/Mastodon followers who've expressed interest in AI tools
- Colleagues or ex-colleagues who understand deliberation use-cases

#### **[HUMAN]** How to Invite

1. **Direct outreach** (DM, email, Slack):
   > "I've built Council — a CLI for multi-expert AI deliberation panels. It's live on npm, and I'm looking for 10–20 early users to try it before broader launch. Interested? Install: `npm i -g @council-ai/cli && council demo`"
2. Include:
   - Link to repo: `https://github.com/pedrofuentes/council`
   - Link to docs (once Pages is live)
   - Request: "Try `council demo`, then run one real deliberation. File issues for anything broken or confusing."
3. **Timing:** Give 3–5 days for feedback before moving to Stage 2

#### Success Signals

- 5+ GitHub issues filed (bugs, feature requests, or questions)
- 2+ positive testimonials or use-case reports
- No critical installation blockers

#### Abort Signals

- Zero engagement after 1 week → revisit messaging or invite list
- Multiple reports of same critical bug → fix before proceeding

---

### Stage 2: Awesome Lists

**When:** Stage 1 feedback incorporated, at least 1 critical bug fixed (if any)
**Goal:** Discoverability via curated community lists

#### **[HUMAN]** Target Lists (Submit PRs)

Research and submit to relevant awesome-lists. Candidates (verify current list guidelines before submitting):

- **awesome-cli-apps** (https://github.com/agarrharr/awesome-cli-apps) — section: AI/Machine Learning or Developer Tools
- **awesome-llm** (search GitHub for `awesome-llm`) — section: Multi-agent or CLI tools
- **awesome-chatgpt** / **awesome-gpt** lists — section: Tools or Multi-agent systems
- **awesome-developer-tools** — section: AI-assisted development

#### Submission Template

```markdown
### Council

Persistent AI expert panels for deliberation and decision-making. Multi-expert debates with memory, disagreement enforcement, and structured decision synthesis. CLI-first, runs on GitHub Copilot.

- [GitHub](https://github.com/pedrofuentes/council)
- [npm](https://www.npmjs.com/package/@council-ai/cli)
```

#### Success Signals

- 2+ PRs merged into awesome-lists
- 10+ GitHub stars from list traffic

#### Abort Signals

- All PRs rejected or ignored → reassess positioning

---

### Stage 3: Show HN

**When:** 2+ awesome-list PRs merged OR 2 weeks after Stage 2 start (whichever comes first)
**Goal:** Hacker News front-page visibility

#### **[HUMAN]** Pre-Post Prep

1. **Title:** "Show HN: Council — AI expert panels in your terminal"
   - Keep under 80 chars
   - Lead with the outcome, not the tech stack
2. **URL:** Link to GitHub repo (`https://github.com/pedrofuentes/council`) or docs site (if docs site is more polished)
3. **First comment** (post immediately after submission):

   ```
   Author here. Council creates persistent expert panels that deliberate and remember across sessions — so you get structured multi-perspective advice instead of single-AI output.

   Quick demo: `npm i -g @council-ai/cli && council demo` (zero-setup, offline)

   Real example: Ask "Should I build or buy analytics?" — Council auto-composes a CTO, CFO, and VP Product, runs a 4-phase debate (opening → cross-exam → rebuttal → synthesis), and the experts remember this discussion in future sessions.

   Built for: architecture decisions, incident postmortems, career choices, startup strategy — anywhere you'd want multiple expert viewpoints instead of one AI's "balanced" response.

   Runs on GitHub Copilot today (no API keys to manage). OpenAI/Anthropic support on the roadmap.

   Happy to answer questions!
   ```

#### **[HUMAN]** Timing

- **Best days:** Tuesday–Thursday
- **Best times:** 8–10 AM PT (Hacker News peak activity)
- **Avoid:** Friday afternoon, weekends, major holidays

#### **[HUMAN]** During Post (First 2 Hours — Critical)

- **Monitor constantly** — respond to every comment within 15 minutes if possible
- **Be helpful, not defensive** — acknowledge limitations ("Great point — that's on the roadmap")
- **Provide context** — many readers skim; clarify the Copilot requirement up-front
- **Don't astroturf** — no fake upvotes, no asking friends to comment (HN detects this and penalizes)

#### Success Signals

- 20+ points within 2 hours
- 5+ substantive comments (not just "cool")
- Front page (top 30) for 1+ hours

#### Abort Signals

- <5 points after 2 hours → post didn't resonate; analyze comments for why
- Negative sentiment ("this is just prompt engineering" / "why not use X instead") without engagement → revisit positioning

---

### Stage 4: Targeted Communities

**When:** Show HN posted (success or abort)
**Goal:** Niche community traction

#### **[HUMAN]** Target Subreddits (One Post Per Community, Spaced 2–3 Days Apart)

Check subreddit rules before posting. Candidates:

- **r/commandline** — "Show & Tell" flair
- **r/cli_apps** — Share post with demo
- **r/ArtificialIntelligence** — Discussion post (not just promo)
- **r/MachineLearning** — "Project" flair (if rules allow)
- **r/SideProject** — "Launch" flair

#### Submission Format (Adapt per subreddit culture)

- **Title:** "I built Council — AI expert panels for multi-perspective deliberation [CLI, open-source]"
- **Body:** Problem → solution → demo command → link. Keep under 500 words.
- **Tone:** Humble, not salesy. Acknowledge it's early-stage.

#### **[HUMAN]** Other Communities (Adapt Messaging)

- **Lobsters** (if you have invite / karma) — tag: `ai`, `cli`
- **dev.to** or **Hashnode** — long-form post: "Why I Built Council" with tutorial
- **Twitter/X** — thread with demo GIF/video + link
- **Mastodon** — post to relevant instances (#CLI, #AI, #OpenSource tags)

#### Success Signals

- 50+ total GitHub stars across all communities
- 3+ community members filing issues or PRs
- Positive sentiment in 70%+ of comments

#### Abort Signals

- Consistent negative feedback ("this is just X with extra steps") → revisit positioning or pause launch
- Zero engagement across 3+ communities → reassess messaging

---

### Stage 5: Product Hunt

**When:** 100+ GitHub stars, 2+ user testimonials, 1+ week after Show HN
**Goal:** Broader non-technical audience visibility

#### **[HUMAN]** Pre-Launch Prep

1. **Product Hunt account** — ensure you have an active account with some history (not brand-new)
2. **Assets:**
   - Logo/icon (512×512)
   - Screenshots (3–5) showing terminal UI, `council demo`, chat interface
   - Tagline (60 chars): "Multi-expert AI deliberation in your terminal"
   - Description (260 chars): Expand on tagline with use-cases
3. **Launch timing:** Tuesday–Thursday, 12:01 AM PT (appears at top of daily feed)

#### **[HUMAN]** Post-Launch (First 24 Hours)

- Respond to every comment
- Share PH link on Twitter, LinkedIn, relevant Slack/Discord communities (without spamming)
- Post "We're live on Product Hunt!" update in GitHub Discussions

#### Success Signals

- Top 10 daily ranking
- 100+ upvotes
- Featured in Product Hunt newsletter (happens automatically if top 5)

#### Abort Signals

- <20 upvotes after 24 hours → low visibility; focus on other channels

---

## 3. Messaging Guardrails

**Use these constraints in all launch communications to avoid overpromising or misleading users.**

### ✅ Honest Positioning

- **Council is a deliberation product**, not an agent framework (no tool use, no code execution by experts)
- **Deliberation ≠ truth** — multiple perspectives improve decisions, but experts can still be wrong
- **GitHub Copilot required today** — state this up-front, not buried in docs
  - Future: "OpenAI and Anthropic support planned" (link to ROADMAP.md §Phase 8)
- **Node.js 24+ required** — not optional (Council uses the built-in `node:sqlite` module)

### ✅ What to Emphasize

- **Structured multi-expert deliberation** — not just "chat with multiple AIs"
- **Anti-sycophancy enforcement** — experts disagree meaningfully (3-layer quality gate)
- **Persistent memory** — experts remember across sessions (unique to Council)
- **Zero-setup demo** — `council demo` works offline, no login required

### 🚫 Don't Overclaim

- **Avoid:** "AI debate always produces better decisions" → **Say:** "Multiple perspectives help surface blind spots"
- **Avoid:** "Council is the best multi-agent system" → **Say:** "Council is a deliberation-focused CLI tool"
- **Avoid:** "Works with any LLM" → **Say:** "Runs on GitHub Copilot today; OpenAI/Anthropic planned"
- **Avoid:** "Council is production-ready" → **Say:** "Council is pre-1.0 software (v0.4.x) — expect evolution"

### 🚨 Don't Launch Everywhere at Once

- **Stagger launches** — space out Show HN, Product Hunt, and subreddit posts by 2–3 days minimum
- **One major platform per week** — gives time to respond, iterate, and incorporate feedback
- **Avoid brigading** — don't cross-post the same link to 10 subreddits in one day (looks like spam)

---

## 4. Post-Launch Operations

### Issue & Discussion Triage

**Goal:** Respond to all issues/discussions within 48 hours (best-effort)

#### **[HUMAN]** Triage SLA (Target, Not Guarantee)

| Type                                            | Response Time | Action                                                                     |
| ----------------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| **Critical bug** (crashes, data loss, security) | 4 hours       | Acknowledge, create hotfix branch, release patch within 24 hours           |
| **Installation blocker**                        | 8 hours       | Provide workaround or fix in next patch                                    |
| **Feature request**                             | 48 hours      | Thank, label `enhancement`, add to backlog (ROADMAP.md or GitHub Projects) |
| **Question/support**                            | 48 hours      | Answer or point to docs; if common, add FAQ to docs                        |
| **Spam/off-topic**                              | 24 hours      | Close with polite redirect                                                 |

#### Labels to Use

- `bug`, `enhancement`, `documentation`, `help wanted`, `good first issue`
- `sentinel:*` labels (for Sentinel-reported findings)
- `launch-feedback` (for issues filed during launch stages)

### Changelog & Announcements

**When:** After each release (Council uses Release Please for automated releases)

#### **[HUMAN]** Announcement Cadence

- **Patch releases (0.4.x):** CHANGELOG.md only (auto-generated by Release Please)
- **Minor releases (0.5.0, 0.6.0):** GitHub Discussions post + optional Twitter/Mastodon thread
- **Major releases (1.0.0):** Full announcement (blog post, Show HN, Product Hunt re-launch, newsletter if list exists)

### Capture Testimonials & Use-Cases

**Why:** Social proof for future launches and docs

#### **[HUMAN]** How to Collect

- When a user posts positive feedback (Twitter, GitHub Discussion, issue comment):
  1. Reply: "Thank you! Mind if I quote this as a testimonial on the docs site?"
  2. If yes: add to `docs/testimonials.md` or feature on homepage
- Track real-world use-cases:
  - "Used Council to decide..." → document in `docs/examples/` or `docs/launch/use-case-copy.md`
  - Especially: architecture decisions, incident postmortems, career choices (these are Council's differentiators)

---

## 5. Success Metrics (Informal Targets)

Council is pre-1.0, so these are directional, not commitments.

| Metric                   | 1 Month Post-Launch | 3 Months Post-Launch | Notes                          |
| ------------------------ | ------------------- | -------------------- | ------------------------------ |
| **GitHub stars**         | 100+                | 500+                 | Proxy for awareness            |
| **npm weekly downloads** | 50+                 | 200+                 | Proxy for usage                |
| **Issues filed**         | 20+                 | 50+                  | Proxy for engagement           |
| **Contributors**         | 2+                  | 5+                   | PRs merged from non-maintainer |
| **Testimonials**         | 3+                  | 10+                  | Positive feedback captured     |

If metrics fall short: reassess positioning, invest in docs/tutorials, or focus on a narrower use-case (e.g., "Council for architecture reviews").

---

## 6. Abort / Pause Criteria

**When to pause public promotion and reassess:**

- **Installation success rate <70%** (based on user reports) → fix critical bugs before continuing
- **Consistent negative sentiment** across 3+ communities → revisit messaging or product-market fit
- **Zero organic engagement** after 2 weeks of Stage 1 → product may not resonate; consider pivoting or shelving
- **Security vulnerability** reported → pause all promotion, release patch, then resume

**It's okay to pause.** Council is a side-project / open-source tool — launch when it's genuinely ready, not on a forced timeline.

---

## Appendix: Commands & Resources

### Verification Commands

```bash
# On a clean machine (no prior Council install):
npm install -g @council-ai/cli
council --version
council doctor
council demo
```

### Internal Resources

- **Launch copy:** `docs/launch/comparison-copy.md`, `docs/launch/use-case-copy.md`
- **Roadmap:** `ROADMAP.md` §Phase 8 (growth)
- **Contributing:** `CONTRIBUTING.md`
- **Examples:** `docs/examples/`

### External Resources

- **npm package:** https://www.npmjs.com/package/@council-ai/cli
- **GitHub repo:** https://github.com/pedrofuentes/council
- **Docs site:** (URL TBD after GitHub Pages publish)

### Maintainer Contacts (Update as Needed)

- **Primary maintainer:** @pedrofuentes
- **Escalation for critical bugs:** File issue + tag @pedrofuentes in GitHub Discussions

---

## Summary

This runbook is a **living document**. Update it after each launch stage to reflect what worked, what didn't, and lessons learned. Document surprises in [LEARNINGS.md](../LEARNINGS.md).

**Next step:** Complete §1 Pre-Launch Readiness Checklist, then proceed to §2 Stage 1 (Friendly Users).
