# Pause and Ask the User During a Debate

## Problem and motivation

Council debates are most valuable when experts can stop speculating and request the missing fact that would change their recommendation. Today the orchestrator drives a fixed sequence: `Debate.run()` emits `panel.assembled`, then dispatches either freeform or structured mode (`packages/cli/src/core/debate.ts:236-260`). In freeform mode, each planned expert turn is sent in order and appended to `priorTurns` only after completion (`packages/cli/src/core/debate.ts:326-449`). Structured mode likewise iterates phases and experts without a mid-turn user intervention point (`packages/cli/src/core/debate.ts:471-525`).

The result is wasted premium requests when an expert recognizes a missing input but the panel proceeds anyway. The motivating feedback example is an expert saying: “If you want Copilot CLI evaluated, paste a transcript of someone struggling with a task, or describe a specific friction point” — but the debate proceeds anyway. The panel should be able to pause, ask that question, inject the answer, and resume with better context.

## Proposed mechanism

Add an explicit `input.requested` debate event and a corresponding pause state in the orchestrator. The event should identify the requesting expert, round, sequence, question text, and a stable request id. A paired internal result should be injected as a synthetic user/context turn, not as an expert response.

Recommended expert signal: explicit notation in the model response, initially prompt-based rather than tool-based. For example:

```text
<request_user_input>
question: Paste the transcript or describe one friction point.
reason: The evaluation depends on a concrete failure mode.
</request_user_input>
```

Detection alone (“the model asked a question”) is too brittle because experts may ask rhetorical questions or include questions as part of analysis. A true tool call would be cleaner long-term, but the current engine abstraction streams text events, so explicit notation minimizes architecture impact while preserving a future upgrade path.

State machine:

1. AI turn streams normally through `#runAiTurn`.
2. The orchestrator detects the explicit request marker before finalizing the turn.
3. It emits `input.requested`, then enters `waiting_for_input`.
4. If an interactive `HumanInputProvider` is configured, it calls that provider with the expert slug, display name, round, seq, and the request question.
5. On submission, the orchestrator emits a synthetic human/user turn such as `turn.delta`/`turn.end` with `speakerKind: "human"`, appends an `input-answer` record to the same context arrays used for prior debate turns, and resumes at the next planned expert turn. The requesting expert’s partial request should not count as the substantive expert answer unless product copy chooses to display it.
6. On cancellation, timeout, or unavailable input, apply the configured fallback.

The answer should enter prompt context as quoted user-provided data, e.g. “User answered Clarifying question from <expert>: …”. It should be available to later freeform `buildCtx()` calls via `priorTurns` (`packages/cli/src/core/debate.ts:290-323`) and to structured debate prompt builders through the phase-specific prior-turn arrays (`packages/cli/src/core/debate.ts:501-512`).

## Code hooks

The existing human participant path is the key reuse point. `#runTurn()` already branches human participants away from `engine.send()` and into `#runHumanTurn()` (`packages/cli/src/core/debate.ts:564-581`). `#runHumanTurn()` validates that a `HumanInputProvider` exists, calls `getInput()` with `{ expertSlug, displayName, round, seq, prompt }`, handles cancellation, emits human `turn.delta`/`turn.end`, and avoids incrementing premium request counters (`packages/cli/src/core/debate.ts:584-642`). The pause feature should reuse this seam by adding a helper such as `#requestUserInput()` that calls the same provider contract rather than introducing a second stdin abstraction.

The provider contract already exists in `packages/cli/src/core/human-input.ts:10-32`. The CLI chat command has a separate `ChatInputProvider` for REPL line input (`packages/cli/src/cli/commands/chat/shared.ts:150-168`), and panel chat wires it through `runPanelChat()` before entering the interactive loop (`packages/cli/src/cli/commands/chat/panel-chat.ts:123-125`, `packages/cli/src/cli/commands/chat/panel-chat.ts:243-257`). Inline `@convene` already runs a `Debate` inside a chat loop with an `AbortController` (`packages/cli/src/cli/commands/chat/panel-chat.ts:369-406`, `packages/cli/src/cli/commands/chat/panel-chat.ts:637-684`), so it can pass an adapter from `ChatInputProvider` to `HumanInputProvider` for pause requests.

For `council convene --human`, the command already accepts `humanInputFactory` and passes a provider only when human slugs are configured (`packages/cli/src/cli/commands/convene.ts:119-145`, `packages/cli/src/cli/commands/convene.ts:805-826`). Pause-and-ask should allow a provider when the session is interactive even if no human participant exists.

## Constraints and fallbacks

This must be TTY-only by default. JSON/NDJSON and piped/CI runs are designed for machine consumption; the JSON renderer writes one event per line for scripts and logs (`packages/cli/src/cli/renderers/json.ts:1-21`). Blocking on stdin during `--json`, redirected stdin, or CI would surprise automation.

Fallback policy should be explicit:

- Default interactive TTY: pause and ask.
- Non-TTY, `--json`, or no provider: continue without input by injecting a short system note: “No user input available; continue with current evidence.”
- Strict future flag: error on missing required input and end with `debate.end` reason `failed`.

Abort handling should reuse existing `AbortController` flow. `Debate.run()` checks `signal.aborted` before mode dispatch and at turn boundaries (`packages/cli/src/core/debate.ts:251-260`, `packages/cli/src/core/debate.ts:392-395`), while panel chat aborts active inline debates on Ctrl+C (`packages/cli/src/cli/commands/chat/panel-chat.ts:317-336`). Input waits should accept the same signal or close the provider on abort.

Renderer implications are modest: PlainRenderer should display a visible prompt/status around `input.requested` and then resume streaming (`packages/cli/src/cli/renderers/plain.ts:61-127`). Ink’s reducer must add a waiting state, because it currently exhaustively handles every `DebateEvent` kind (`packages/cli/src/cli/renderers/ink/InkRenderer.tsx:155-275`). JSON should emit `input.requested` and synthetic answer events without attempting to read input.

## Alternatives considered

1. **Always continue and let experts ask in prose.** Zero implementation risk, but it preserves the current waste: the panel spends additional premium requests while missing a known prerequisite.
2. **Add a model tool for `request_user_input`.** Semantically strongest and easiest to validate, but it depends on engine/tool-call support across providers and renderers. This should be a future migration path.
3. **Use a human participant via `--human`.** Reuses existing code, but it forces the user to occupy a scheduled panel seat rather than responding only when clarification is needed.

Recommendation: start with explicit notation plus the existing `HumanInputProvider` seam. It is incremental, testable, and compatible with later tool-call support.

## Open questions and out of scope

Open questions: Should answers be persisted as user turns in debate history? Should experts be allowed multiple pauses per turn or capped per debate? Should the requesting expert get an immediate follow-up turn, or should the normal sequence continue?

Out of scope: production implementation, tests, renderer code changes, new engine tool APIs, and policy for sensitive or secret user answers.
