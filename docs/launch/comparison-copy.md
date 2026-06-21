# Council vs. Agent Frameworks

## Not Another Framework—A Product for Deliberation

Most AI tooling falls into two categories: **frameworks** that help you build agent systems, and **products** that solve specific problems out of the box. Council sits firmly in the second camp.

**Council is not another agent framework**—it's a terminal-native AI deliberation product: persistent expert panels that disagree, remember, and produce decision-ready synthesis. You don't build on Council; you use it to convene a panel of AI experts, watch them debate, and get structured output you can act on.

This distinction matters. If you need to construct custom agent workflows, routing logic, or tool integrations, reach for a framework. If you need a ready-to-use deliberation panel for architecture reviews, incident postmortems, or strategic decisions, Council is already built.

## Comparison Table

| Tool              | Primary Job                                                                                 | Does the User Build It?                                                                   | Best For                                                                                     | How Council Differs                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CrewAI**        | Framework for building multi-agent task workflows with role-based crews                     | Yes—you define agents, roles, tasks, and orchestration                                    | Custom business automation, sequential task pipelines, role-based agent teams                | Council is a ready-to-use product: you convene a panel, it deliberates, you get synthesis. No code, no orchestration—just run `council convene`.                                                                                                                                  |
| **AutoGen / AG2** | Framework for building conversational multi-agent systems with flexible group chat patterns | Yes—you configure agents, conversation patterns, termination logic, and tool integrations | Research prototypes, complex conversational workflows, LLM application development           | Council gives you a deliberation panel immediately. No setup, no agent configuration—just describe your problem and Council assembles, moderates, and synthesizes for you.                                                                                                        |
| **LangGraph**     | Framework for building stateful agent workflows as graphs with explicit control flow        | Yes—you design nodes, edges, state schemas, and routing logic                             | Production agent systems needing precise control, cyclic workflows, complex state management | Council handles state, memory, and workflow for you. It's a product focused on panel-based deliberation, not a building block for custom agent graphs.                                                                                                                            |
| **aider**         | AI pair programming tool for editing codebases with LLM assistance                          | No (product)—but narrow: code editing only                                                | In-editor code generation, refactoring, and git-integrated development                       | Council is deliberation-focused, not code-focused. Use aider to edit files; use Council to convene expert panels that debate architecture, review decisions, or analyze incidents. Council remembers context across sessions and produces structured synthesis, not code patches. |

## When to Use What

**Use frameworks** (CrewAI, AutoGen, LangGraph) when you're building custom agent systems: you need specific tool integrations, custom routing logic, or domain-specific workflows that don't exist yet. You'll write code, wire agents together, and own the orchestration.

**Use Council** when you need panel-based deliberation now: architecture reviews, incident postmortems, strategic decisions, or career planning. No code, no setup—just `council convene "Should we migrate to microservices?"` and get a moderated debate with synthesis.

**Use aider** when you're actively editing code and want LLM assistance in your git workflow.

Council doesn't replace frameworks—it solves a different problem. If "convene a panel of experts who disagree and synthesize their insights" describes your need, Council is already built. If you're constructing a custom agent system, reach for a framework.

## Provider Flexibility

Council uses **GitHub Copilot** today (no API keys, no setup). Support for OpenAI and Anthropic direct integrations is coming soon. You're not locked into a single provider—Council abstracts the model layer so you can switch or compare providers as your needs evolve.

## The Honest Answer

Frameworks empower builders. Council serves decision-makers. Use frameworks to build agent systems. Use Council to get a decision panel today.
