# Pricing Decision: Price Increase for New Customers

> **Note:** This is an illustrative example transcript showing the output shape of a `council convene` session followed by `council conclude` and `council export`. It demonstrates how Council's expert panel deliberates on a high-stakes pricing decision.

## Decision Prompt

"Should we raise prices 20% for new customers only, keeping existing customers at current rates? We're a B2B SaaS with 400 customers, $2.4M ARR, and 15% monthly growth."

## Panel Roster

- **Samira Khan (VP Revenue)** — Former pricing lead at a Series B startup; focused on margin expansion and revenue per customer
- **David Ortega (CFO)** — 8 years in SaaS finance; models unit economics and long-term profitability
- **Rachel Liu (Head of Sales)** — Closes 60% of her deals; viscerally understands customer price sensitivity and deal friction
- **Kenji Tanaka (Customer Advocate)** — Former support lead; represents long-term customer retention and fairness perception

---

## Round 1: Initial Positions

### Samira Khan (VP Revenue)

A 20% increase on new customers is **overdue**, not aggressive. Our pricing hasn't changed in 18 months while we've shipped: API v2 with 10× rate limits, advanced analytics, SSO, and audit logs. Competitors charge 40–50% more for comparable feature sets. We're leaving $400K+ annually on the table by underpricing.

The "new customers only" approach is strategically sound: it avoids the backlash of repricing our base, it tests price sensitivity with a cohort that has no reference point, and it sets up a future migration path where we can offer existing customers "upgrade to premium" pricing tiers. This is textbook SaaS pricing strategy—expand margin on new logos while protecting existing revenue.

### David Ortega (CFO)

Samira's revenue math is correct, but her **timing** assumption is flawed. We're growing 15% month-over-month, which means we're adding ~50 customers per month. A 20% price increase on new customers yields $8K additional MRR this month, $16K next month, $24K the month after—it takes 12 months to add $400K ARR, not one quarter.

Meanwhile, we're burning $180K/month and have 8 months of runway. Margin expansion is important, but the **velocity** of revenue growth is more important right now. If a 20% price increase slows our close rate from 60% to 48%, we've shot ourselves in the foot. We need Samira to run a price sensitivity analysis with our last 100 deals before we pull this trigger.

### Rachel Liu (Head of Sales)

David, I **have** that data, and the news isn't good. In Q1, I tested a "premium tier" pitch at 25% above standard pricing on 15 deals. My close rate dropped to 40%, and the average sales cycle stretched from 28 days to 41 days. Prospects didn't say "no" outright—they said "we need to involve procurement" or "let's revisit next quarter," which is sales-speak for "you're too expensive."

Here's the second-order effect Samira's missing: if we raise prices now, our sales messaging shifts from "we're the best value in the category" to "we're competitively priced." That's a psychological shift. Our current win rate is **because** prospects perceive us as a no-brainer deal. A 20% increase doesn't just change the math—it changes the buyer's mental model of who we are.

### Kenji Tanaka (Customer Advocate)

I need to surface a different risk: **perceived fairness**. We have 400 existing customers who will eventually discover that new customers are paying 20% more for the **same** product. That pricing delta creates two problems:

1. **Negotiation leverage inversion:** Existing customers will use the lower price as an anchor in renewal negotiations. "You're charging new customers $600/month, but I'm only paying $500—clearly the product is worth $500."
2. **Community backlash:** SaaS pricing is not a secret. When a new customer posts in our Slack community or compares notes at a conference, the "new customers pay more" dynamic breeds resentment. Existing customers won't feel lucky—they'll feel like chumps when the new pricing becomes public knowledge.

The fairness issue is solvable **if** we commit to grandfathering existing customers permanently. But if the plan is to eventually migrate everyone to the new pricing, we're just delaying the conflict.

---

## Round 2: Direct Challenges

### Samira Khan (VP Revenue)

Rachel, your Q1 premium tier test is not comparable. You were pitching a **new tier** with differentiated features, which introduces buyer confusion. A straight 20% increase on the **same** tier with messaging like "we've expanded the platform significantly since launch" is a different conversation. Buyers expect SaaS products to increase prices as they mature—it's a signal of value creation, not a penalty.

Kenji, the fairness argument assumes customers have perfect information, which they don't. Pricing is not typically disclosed in SaaS communities, and if it is, the new customer is the one who looks foolish for paying more, not the existing customer for paying less. The "grandfathering" framing is exactly right—we tell existing customers, "You're locked in at legacy pricing because you took a bet on us early." That's a **reward**, not a slight.

### David Ortega (CFO)

Samira, you're brushing past the close rate risk. Even if Rachel's Q1 test isn't a perfect comp, directionally it's a warning signal. Let's model the break-even scenario: if a 20% price increase drops our close rate from 60% to 54% (10% decline), we're revenue-neutral in month one. If it drops to 50%, we're losing revenue despite higher per-customer pricing.

Given our runway constraint, we can't afford a 3-month experiment that **might** increase revenue. Here's an alternative: instead of raising prices globally, run a **regional price test**—20% increase for new customers in high-willingness-to-pay markets (US, UK) and hold pricing steady in price-sensitive markets (LATAM, APAC). That gives us data without betting the company.

### Rachel Liu (Head of Sales)

David, I like the regional test idea, but let's be clear: it doesn't solve my objection. US deals are 70% of our pipeline. If we raise prices there and close rate drops, we've damaged our primary revenue engine. And Samira, I'm not "brushing past" anything—my Q1 test **was** the same tier, just positioned differently. The underlying insight stands: our buyers are price-sensitive.

Here's the proof: our average deal size is $500/month. A 20% increase is $100/month or $1,200/year. For a mid-market company with $5M revenue, that's 0.02% of their budget—a rounding error. They should say yes instantly. The fact that they **don't** means price is functioning as a **screening heuristic**, not a rational cost-benefit analysis. If we're over $X, we're "too expensive" regardless of ROI.

### Kenji Tanaka (Customer Advocate)

Samira, you're wrong about information asymmetry. Our customers **do** compare pricing—I see it in support tickets every week. Someone asks, "Why is my invoice $500 when my colleague at another company pays $600?" or "I saw your pricing page says $600, but I'm grandfathered at $500—what happens at renewal?" These aren't edge cases; they're 8–10 tickets per month.

The "early adopter reward" framing works **if** we communicate it proactively and consistently. But if customers discover the price delta organically, they interpret it as "the company is trying to extract more value from new customers while keeping me in the dark." The perception is manipulation, not appreciation.

---

## Synthesis

The panel identifies a **revenue/risk misalignment**: Samira's growth math is correct (20% lift on new customers = significant ARR expansion), but Rachel and David's operational constraints are real (close rate risk + 8-month runway). The decision hinges on **price elasticity**, which the team has partial data on but not definitive proof.

The panel converges on a **staged approach** rather than an all-or-nothing move:

### Recommended Path: Controlled Price Experiment

1. **Phase 1 (Month 1–2):** Run a **regional price test** on new US deals only—20% increase, measure close rate and sales cycle length. Success criteria: close rate stays above 55% and cycle length under 35 days.
2. **Phase 2 (Month 3):** If Phase 1 succeeds, expand to UK/EU. If it fails (close rate < 55%), roll back and investigate **feature-gated pricing** instead (keep base price flat, charge for premium features like SSO and audit logs).
3. **Existing customer communication:** Proactively message the pricing change as an "early adopter lock-in" benefit. Script: "As a founding customer, you're grandfathered at $500/month indefinitely. New customers joining today pay $600 for the same features—your early commitment is valued."

### Why This Beats the Original Proposal

- **De-risks close rate impact:** Regional test limits downside to 30% of pipeline, not 100%.
- **Generates real data:** After 2 months, the team knows whether 20% is viable or needs refinement.
- **Preserves fairness narrative:** Proactive communication shifts customer perception from "hidden price hike" to "loyalty benefit."
- **Buys time for feature-gated alternative:** If price sensitivity is higher than expected, the team has a fallback (charge for premium features rather than raising base price).

### What Could Still Go Wrong

- **Sales team executes poorly:** If reps aren't confident in the new pricing, they'll discount preemptively. Requires tight sales enablement and role-playing before launch.
- **Runway pressure forces premature scale:** If Phase 1 data is ambiguous (close rate drops to 56%), leadership might prematurely expand to all regions due to cash constraints. Discipline required.
- **Competitive response:** If a competitor notices the price increase and undercuts, the test becomes polluted. Monitor competitor pricing weekly during the experiment.

---

## Next Actions

1. **Immediate (Week 1):** Samira and Rachel align on **regional test design**—specific geographies, sample size (minimum 30 deals), success metrics, and kill criteria (if close rate < 50% in first 15 deals, abort).
2. **Week 2:** Draft **customer communication** for existing customers explaining the price change and grandfathering policy. Kenji reviews for tone and fairness perception.
3. **Week 3:** Sales enablement session—role-play pricing objections, document responses to "Why did the price increase?" and "Can you match my existing rate?"
4. **Week 4:** Launch Phase 1 test for US new customers only. Weekly review of close rate, sales cycle, and qualitative feedback from lost deals.
5. **Month 3 decision point:** Go/no-go on expanding to other regions based on Phase 1 data. If no-go, pivot to feature-gated pricing model.

---

**Session ID:** `pricing-increase-2025-06-20`  
**Concluded:** 2025-06-20T16:45:33Z  
**Model:** claude-sonnet-4.5 (all experts)
