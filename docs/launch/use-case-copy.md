# Use Cases: When to Convene a Council

Council shines when you need **structured deliberation from multiple perspectives**—not a single LLM answer, but a moderated debate that surfaces tradeoffs, dissent, and synthesis. Here are five scenarios where Council delivers decision-ready insight.

---

## 1. Architecture Reviews

### The Problem

You're considering a major architectural change: microservices migration, event-driven refactor, or database swap. A single LLM gives you a confident answer, but confidence isn't the same as wisdom. You need tradeoffs, dissent, and a synthesis that weighs operational reality against technical ideals.

### Example Prompt

```bash
council convene "We're a 50-person startup running a Rails monolith on Heroku. \
Should we migrate to microservices on Kubernetes? We have 3 backend engineers, \
~10k daily active users, and our current deployment takes 8 minutes."
```

### The Panel

Council assembles:

- **Pragmatic Architect** (push back on over-engineering, prioritize delivery)
- **Operations Engineer** (focus on operational complexity, monitoring, on-call burden)
- **Distributed Systems Specialist** (highlight consistency challenges, network failures)
- **Business-Oriented Technologist** (evaluate cost, time-to-market, team velocity)

### Sample Dissent

> **Operations Engineer:** "Kubernetes adds significant operational overhead. With 3 engineers, who's on-call when a pod crashes at 2am? The Rails monolith's failure modes are well-understood. K8s failure modes multiply."

### Output Shape

- **Synthesis:** Weighted recommendation (stay monolithic now, extract 1-2 services as experiments)
- **Key Tradeoffs:** Deployment complexity vs. scaling flexibility
- **Risks Surfaced:** Operational burden, team size constraints, premature optimization
- **Next Steps:** Concrete actions (e.g., "Profile the monolith, identify the hottest 10% of requests, and extract only those services")

### Try It

```bash
council demo architecture
council convene "Your architecture question here"
```

---

## 2. Startup Decisions

### The Problem

Startup decisions carry asymmetric risk: pivoting your pricing model, choosing a market segment, or deciding whether to fundraise. You need diverse perspectives—growth-obsessed, risk-averse, customer-centric—not a single voice optimizing for one dimension.

### Example Prompt

```bash
council convene "We're a B2B SaaS with 50 paying customers at $500/month. \
Should we shift to a freemium model to accelerate growth, or stay \
pay-only to focus on revenue quality? Churn is 8%, CAC is $1200, LTV is $6000."
```

### The Panel

Council assembles:

- **Growth-Focused PM** (prioritize acquisition, viral loops, conversion funnels)
- **Finance-Oriented Advisor** (focus on unit economics, cash flow, runway)
- **Customer Success Strategist** (surface support burden, user quality, churn signals)
- **Competitive Analyst** (evaluate market positioning, competitor moves)

### Sample Dissent

> **Finance-Oriented Advisor:** "Freemium inflates your CAC by adding support costs for users who never convert. With $1200 CAC and 8% churn, your margin for error is already thin. Free users could burn your runway."

### Output Shape

- **Synthesis:** Conditional recommendation (e.g., "Freemium only if you have a clear activation metric and can limit support surface")
- **Scenarios:** What-if analysis (e.g., "If free-to-paid conversion is <5%, runway shrinks by 4 months")
- **Dissent Captured:** Where the panel disagreed and why
- **Decision Framework:** Metrics to watch, kill criteria, rollback plan

### Try It

```bash
council demo startup
council convene "Your startup decision here"
```

---

## 3. Incident Postmortems

### The Problem

After an outage, your team writes a postmortem. But one perspective (SRE, product, customer support) dominates, and blind spots persist. You need a panel that interrogates assumptions, surfaces hidden causes, and challenges the "what we'll do next time" section.

### Example Prompt

```bash
council convene "Our payment processor API went down for 3 hours yesterday. \
We retried failed requests, but our retry backoff was too aggressive and \
hammered their recovering service. What went wrong, and what should we change?"
```

### The Panel

Council assembles:

- **SRE / Reliability Engineer** (focus on monitoring, alerting, circuit breakers)
- **Distributed Systems Specialist** (highlight backpressure, cascading failures)
- **Customer Impact Analyst** (quantify user-facing damage, communication gaps)
- **Process-Oriented Leader** (evaluate incident response runbooks, post-incident review quality)

### Sample Dissent

> **Customer Impact Analyst:** "We spent 3 hours debugging, but customers only heard from us 90 minutes in. The technical fix matters, but our communication failure extended the reputational damage."

### Output Shape

- **Root Cause Synthesis:** Technical (retry storm), process (no circuit breaker), communication (delayed customer update)
- **Contributing Factors:** Why each condition was necessary (vendor outage + aggressive retry + no backoff + silent failure)
- **Recommendations:** Prioritized (circuit breaker first, retry policy second, runbook update third)
- **Follow-Up Questions:** What the panel still doesn't understand (e.g., "Why didn't existing alerts fire?")

### Try It

```bash
council demo incident
council convene "Your incident description here"
```

---

## 4. Career Decisions

### The Problem

Career crossroads—accepting a VP offer, joining a startup, or pivoting to a new field—carry long-term consequences. You need a panel that challenges your assumptions, surfaces blind spots, and asks the uncomfortable questions your friends might avoid.

### Example Prompt

```bash
council convene "I'm a senior engineer at BigCo, 8 years in. A Series A startup \
offered me a founding engineer role at 60% of my current salary plus equity. \
I have 2 kids, a mortgage, and I'm burned out. Should I take it?"
```

### The Panel

Council assembles:

- **Risk-Averse Advisor** (focus on financial stability, family obligations)
- **Career Growth Strategist** (evaluate long-term upside, skill development, market position)
- **Startup Operator** (highlight startup realities: equity risk, role ambiguity, hours)
- **Work-Life Balance Advocate** (interrogate burnout, stress sources, sustainable pace)

### Sample Dissent

> **Startup Operator:** "Founding engineer at Series A often means you're building the team, not just building the product. If you're burned out now, hiring, onboarding, and unblocking junior engineers will amplify that. Equity is a lottery ticket, not a salary replacement."

### Output Shape

- **Synthesis:** Conditional recommendation (e.g., "If your burnout stems from BigCo bureaucracy, startup chaos might help—but if it's hours or impact invisibility, startups amplify both")
- **Questions to Ask:** Due diligence (runway, cap table, founder dynamics, role clarity)
- **Risks Surfaced:** Financial (salary cut), personal (family stress), professional (equity might vest to zero)
- **Decision Timeline:** What to decide now vs. what to negotiate or clarify first

### Try It

```bash
council demo career
council convene "Your career question here"
```

---

## 5. Document-Trained Advisors

### The Problem

You have internal documents—technical specs, prior postmortems, team decision logs—but synthesizing them for a new decision is tedious. You need a panel that has read your context and debates in light of your organization's history and constraints.

### Example Prompt

```bash
council panel docs link incident-review --path ./postmortems/
council convene --panel incident-review \
"We had another payment gateway outage today. Based on our previous incidents, \
what pattern are we missing, and what should we change?"
```

### The Panel

Council assembles experts aware of your uploaded documents:

- **Pattern Recognition Specialist** (surface recurring themes across incidents)
- **Process Improvement Advisor** (evaluate whether recommendations from prior postmortems were implemented)
- **Systems Thinker** (identify upstream causes, not just proximate failures)
- **Accountability-Focused Leader** (ask why previous action items didn't prevent this recurrence)

### Sample Dissent

> **Accountability-Focused Leader:** "Both prior postmortems recommended a circuit breaker. It's now 3 months later, and we still don't have one. This isn't a technical gap—it's a prioritization and follow-through gap."

### Output Shape

- **Cross-Incident Patterns:** What repeats (e.g., "Every incident involves retry storms, yet we haven't deployed a global rate limiter")
- **Implementation Gaps:** Which prior recommendations were ignored, and why
- **Synthesis:** What's different this time (new failure mode) vs. what's the same (recurring process failure)
- **Prioritized Actions:** Based on incident frequency and blast radius

### Try It

```bash
council panel docs link your-panel --path ./your-docs/
council convene --panel your-panel "Your question here"
```

---

## Common Thread: Disagreement → Synthesis

Every use case follows the same pattern:

1. **You describe the problem** (architecture, startup, incident, career, document-driven)
2. **Council assembles a panel** (diverse expertise, no single "right" answer)
3. **The panel debates** (dissent surfaces blind spots, tradeoffs emerge)
4. **Synthesis arrives** (weighted recommendations, risks, next steps)

Council doesn't replace your judgment—it structures the deliberation so you can make a better-informed decision.

---

## Next Steps

**See it in action:**

```bash
council demo
```

**Convene your first panel:**

```bash
council convene "Your question here"
```

No setup. No API keys (uses GitHub Copilot). Persistent memory across sessions. Structured synthesis for decision-making.

**Ready when you are.**
