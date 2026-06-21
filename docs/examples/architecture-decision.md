# Architecture Decision: Monolith to Microservices Migration

> **Note:** This is an illustrative example transcript showing the output shape of a `council convene` session followed by `council conclude` and `council export`. It demonstrates how Council's expert panel deliberates on a real architectural decision.

## Decision Prompt

"Should we migrate our monolithic Rails app to microservices? We have 8 engineers, 200K monthly active users, and our deploy cycle is 2 weeks."

## Panel Roster

- **Elena Rodriguez (CTO)** — Former infrastructure lead at a high-growth SaaS company; focused on operational risk and team capacity
- **Marcus Chen (Staff Engineer)** — 12 years building distributed systems; pragmatic about complexity tradeoffs
- **Jordan Kim (SRE Lead)** — On-call owner for production; laser-focused on observability and failure modes
- **Alex Patel (Product Manager)** — Ships features quarterly; cares about velocity and customer-facing impact

---

## Round 1: Initial Positions

### Elena Rodriguez (CTO)

The real question isn't "microservices or not"—it's "can we afford the distraction?" We have 8 engineers. A proper migration means service boundaries, inter-service auth, distributed tracing, service mesh or at minimum client libraries, deployment orchestration. That's 6–9 months of infrastructure work before we ship a single customer-facing feature.

Meanwhile, our monolith deploys in 2 weeks because we're **choosing** a 2-week cycle, not because Rails forces it. If velocity is the problem, we could move to continuous deployment on the monolith in 6 weeks with feature flags and better CI. That's 8× faster than microservices and doesn't strand us in a half-migrated state.

### Marcus Chen (Staff Engineer)

Elena's right about the timeline, but she's underselling the monolith's future pain. Our Rails app is 120K lines now and growing 20% per year. In 3 years, that's 200K+ lines. The cognitive load alone will slow us down—new engineers take 4 weeks to ship their first PR because they have to understand the entire dependency graph.

I'm not arguing for a big-bang rewrite. But if we extract **one** service—say, the notification system that's already somewhat isolated—we learn the hard lessons (deployment, observability, failure handling) on a non-critical path. We keep 90% of the code in the monolith and get real data on whether microservices help us or hurt us. That's 2 months of work, not 9.

### Jordan Kim (SRE Lead)

Marcus's "one service" idea sounds low-risk until you debug a cascading failure at 3 AM. The monolith is **simple to reason about** when it fails: one process, one log stream, one database connection pool. A partial migration gives us the worst of both worlds—synchronous calls between services (because we're not ready for event-driven yet), distributed tracing that half-works, and dual deploy pipelines.

The notification system Marcus mentioned? It's called by 14 different controllers. If it's down or slow, do we fail the parent request? Retry? Queue it? Each choice adds code and failure modes. The monolith's weakness is deploy speed; microservices' weakness is operational complexity. We're trading a solved problem for an unsolved one.

### Alex Patel (Product Manager)

I need to push back on something: none of you have mentioned **why** we're having this conversation. We're not having it because the monolith is slow—our p95 latency is 200ms and we're nowhere near database limits. We're having it because our CEO read a blog post about how Shopify uses microservices.

If we're trying to ship faster, microservices won't help. If we're trying to scale, we're 5× away from needing it. The only legitimate reason is if domain boundaries in our code are so tangled that we literally can't reason about them—and I don't think that's true yet. Our billing module is clean, our user management is clean. We just need better file organization and module boundaries **within** Rails.

---

## Round 2: Direct Challenges

### Elena Rodriguez (CTO)

Marcus, your "learn on a non-critical path" logic is backwards. If the notification service is non-critical, why does it justify 2 months of infrastructure work? And if it **is** critical enough to invest in, Jordan's right that we're now debugging distributed systems failures on something that affects every user-facing flow.

Alex, I agree the CEO trigger is suspect, but let's not ignore the engineer happiness angle. Three of our engineers have told me they're frustrated by the monolith's test suite taking 8 minutes and the deploy friction. Microservices won't fix test speed, but **monorepo tooling** and **better CI parallelization** will—for 10% of the cost.

### Marcus Chen (Staff Engineer)

Elena, you're conflating "infrastructure work" with "wasted work." Those 2 months buy us three things: (1) proof that our team can run multiple services without collapsing, (2) a deployment pattern we can copy for future extractions, and (3) isolation of the notification system so we can iterate on push delivery without coordinating with the rest of the app. That's not a science experiment—it's a real win.

Jordan, you're right that failure modes get harder. But "simple to reason about" doesn't mean "simple to change." Our monolith has a 14-step deploy checklist because one deploy in 2023 brought down billing for 90 minutes. The simplicity you're defending is **fragility**.

### Jordan Kim (SRE Lead)

Marcus, that 14-step checklist exists because we don't have automated rollback and proper feature flags—**process** problems, not architecture problems. Microservices won't fix a team that doesn't have disciplined deployment hygiene. They'll just add network partitions, timeouts, and version skew to the list of things that can go wrong.

And here's the kicker: if we extract notifications and it goes badly, we can't just "put it back" into the monolith. We've now burned 2 months, fragmented the team's focus, and we're stuck maintaining two systems because the rollback cost is higher than the status quo cost.

### Alex Patel (Product Manager)

Can we ground this in customer impact? Marcus, your "iterate on push delivery" benefit—are we actually blocked on that? Our notification delivery rate is 94%, which is industry-standard. The 6% failures are mostly bad tokens from uninstalled apps, not something microservices would fix.

Elena, if three engineers are frustrated, I'm sympathetic, but let's solve the actual problem. If test speed is the issue, we can parallelize tests or invest in faster CI runners. If deploy friction is the issue, we can do continuous deployment with feature flags. We don't need a microservices architecture to fix a CI/CD workflow problem.

---

## Synthesis

The panel exposes a misalignment between the **stated problem** (2-week deploy cycle) and the **proposed solution** (microservices). The architectural pull toward microservices is coming from:

1. **Perceived** inevitability ("we'll need it eventually, so start now")
2. Engineer frustration with CI/CD friction (which microservices won't solve)
3. Executive pattern-matching to high-scale companies (premature optimization)

The panel converges on this: **microservices are not the next move**. The real leverage points are:

- **Continuous deployment with feature flags** — solve the velocity problem in 6 weeks instead of 9 months
- **Modular monolith with enforced boundaries** — get 80% of the organizational benefits (team ownership, clear interfaces) without the operational cost
- **Observability and testing improvements** — tackle the actual pain points (slow tests, hard-to-debug failures) that won't improve with microservices

If the team **still** wants to explore microservices after those wins, Marcus's "one non-critical service" proposal becomes viable—but only after the baseline operational discipline (automated rollback, feature flags, distributed tracing) is in place. Extracting a service without those foundations is a recipe for 3 AM pages and team burnout.

---

## Next Actions

1. **Short term (next 6 weeks):** Spike on continuous deployment for the monolith—feature flags, trunk-based development, automated rollback. Target: daily deploys with < 2% rollback rate.
2. **Medium term (3 months):** Introduce module boundaries in the monolith using Rails engines or packwerk. Enforce dependencies between "billing," "notifications," "user management" modules—prove we can achieve team ownership without network hops.
3. **Re-evaluate (6 months):** If the monolith's domain boundaries are still tangled after modularization, or if we hit database scaling limits, revisit service extraction with a proven operational foundation.
4. **Engineer happiness:** Address the stated frustrations (test speed, deploy friction) as first-class problems, not symptoms that require microservices to solve.

---

**Session ID:** `arch-monolith-2025-06-20`  
**Concluded:** 2025-06-20T14:32:11Z  
**Model:** claude-sonnet-4.5 (all experts)
