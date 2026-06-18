# Council — Manual Smoke Test Checklist

Run this checklist against a real Copilot engine before every release.
Automated tests cover behavior in isolation and against `MockEngine`;
this checklist is the final gate that exercises the full system end to
end with a live LLM, an interactive TTY, and the user's real
filesystem.

> **Release workflow**
>
> Release Please maintains a "Release PR" that accumulates unreleased
> changes. Before merging that PR, run this smoke test checklist against
> the release branch. File any ⚠️/❌ as a GitHub issue tagged
> `release-blocker` before shipping.

> **Prerequisites**
>
> - Authenticated GitHub Copilot: `gh auth status` shows an active
>   token with Copilot access, AND `copilot --version` runs cleanly.
> - Clean test home: `export COUNCIL_DATA_HOME=$(mktemp -d)` (Linux/macOS)
>   or `$env:COUNCIL_DATA_HOME = Join-Path $env:TEMP ("council-smoke-" + [guid]::NewGuid()); New-Item -ItemType Directory -Path $env:COUNCIL_DATA_HOME | Out-Null` (PowerShell)
>   so smoke results never collide with your real `~/Council/`.
> - Latest build: `pnpm install && pnpm build && pnpm link --global`
>   (or run `node ./dist/bin/council.js` directly).
> - Reset between sections by `rm -rf $COUNCIL_DATA_HOME/*` if a prior step
>   left state you no longer want.

For every checked box, also note: ✅ pass, ⚠️ pass-with-issue, ❌ fail.
File any ⚠️/❌ as a GitHub issue tagged `release-blocker` before
shipping.

---

## 1. Doctor & first-run sanity

- [ ] `council doctor` reports Copilot SDK reachable and DB writable.
- [ ] `council doctor --models` lists known model identifiers.
- [ ] `council doctor` runs the online probe by default, creates a session
      against the configured default model, and reports that session creation
      succeeded; `--offline` skips the online probe.
- [ ] First-ever run on a fresh `COUNCIL_DATA_HOME` creates the directory
      tree (`experts/`, `panels/`, `council.db`) without errors.
- [ ] `council --help` and `council <subcommand> --help` render
      without crashes.

## 2. Expert library CRUD

- [ ] `council experts list` on a fresh home prints "no experts yet"
      (or equivalent) and exit code 0.
- [ ] `council expert create --slug cto --name "CTO" --role "Chief Technology Officer" --expertise "architecture,strategy" --stance "pragmatic"` finishes by
      writing `$COUNCIL_HOME/experts/cto.yaml` and a row in
      `expert_library`.
- [ ] `council experts list` now shows `cto` with the chosen display
      name.
- [ ] `council experts inspect cto` shows full YAML body, kind, and
      panels-membership ("none" expected here).
- [ ] `council experts edit cto` opens `$EDITOR`, accepts a saved
      change to `displayName`, re-validates the YAML, and refuses to
      rename the slug.
- [ ] `council experts delete cto` removes both the YAML file and the
      DB row. A second `delete cto` reports "not found" cleanly.

## 3. Panel library CRUD

- [ ] Create three experts (`council expert create --slug cto --name "CTO" --role "Chief Technology Officer" --expertise "architecture,strategy" --stance "pragmatic"`, `council expert create --slug sre --name "SRE" --role "Site Reliability Engineer" --expertise "reliability,operations" --stance "risk-focused"`, `council expert create --slug pm --name "PM" --role "Product Manager" --expertise "product,prioritization" --stance "user-focused"`).
- [ ] `council panel create arch-review` (interactive): wizard lets
      you multi-select experts numerically, accepts mode = freeform,
      writes `$COUNCIL_HOME/panels/arch-review.yaml` and rows in
      `panel_library` + `panel_members`.
- [ ] `council panel list --format table` shows `arch-review` with the
      three members in the order you picked.
- [ ] `council panel list --format json` is parseable JSON with the
      same content.
- [ ] `council panel inspect arch-review` resolves each slug back to
      its full expert definition (display names, roles).
- [ ] `council panel edit arch-review` rejects a YAML save where you
      added a non-existent expert slug; accepts a valid edit and
      re-syncs the DB checksum.
- [ ] Deleting an expert that's a panel member without `--force` is
      refused; `--force` reports the affected panels and removes the
      row.

## 4. Built-in panels & migration behavior

- [ ] On a fresh home, `council convene --template architecture-review
    "Should we adopt GraphQL?"` runs the built-in panel without
      manual setup.
- [ ] After the first `--template` run, `$COUNCIL_HOME/experts/`
      contains the extracted built-in expert YAMLs (cto, staff-eng,
      etc.) and `$COUNCIL_HOME/panels/architecture-review.yaml` uses
      slug references.
- [ ] Pre-create `$COUNCIL_HOME/experts/cto.yaml` with a custom
      definition before running `--template architecture-review` for
      the first time on another fresh home: the migration must NOT
      overwrite your custom file, and the resulting panel must
      reference your `cto`, not the built-in one.
- [ ] Delete the migrated `experts/cto.yaml` and re-run
      `--template architecture-review`: the built-in `cto` is
      restored.

## 5. Debate (`council convene`)

- [ ] `council convene --template code-review --max-rounds 1
    --max-words 60 "What's one risk of skipping observability in
    MVPs?"` finishes within ~90 s, prints turns from each panel
      member, and exits 0.
- [ ] `council convene` with no `--template` and a non-trivial topic
      auto-composes a panel; you are prompted to confirm; `y`
      proceeds, `n` aborts cleanly with no DB writes.
- [ ] `--yes` skips the auto-compose confirmation.
- [ ] `--engine copilot` and the default engine produce equivalent
      output structure (turn order, terminal `debate.end` event in
      `--format json`).
- [ ] `council convene --template career-coaching "Should I move to
    management?" --max-rounds 2` runs both rounds and persists
      every turn to `council.db`.

## 6. 1:1 expert chat

- [ ] `council chat cto`: prompt appears, Ctrl+D / `/exit` quits
      cleanly, leaving an active session.
- [ ] Send 3+ user messages; each receives a streamed expert
      response. `council chat cto` invoked again RESUMES the same
      session (history visible).
- [ ] `council chat cto --history` lists the active session and any
      archived ones; archived sessions are excluded from the resume
      target.
- [ ] `council chat cto --new` starts a fresh session even when an
      active one exists; both show in `--history`.
- [ ] Long single response (force a 600+ word answer) renders
      progressively; no buffer truncation.

## 7. Panel chat

- [ ] `council chat arch-review`: typing a general message routes to
      every expert in the panel; responses arrive in panel order.
- [ ] `council chat arch-review --new` starts a fresh panel session.
- [ ] Resume a panel chat: `council chat arch-review` re-loads the
      transcript on launch.

## 8. `@mention` routing (panel chat only)

- [ ] `@cto what would you ship first?` routes ONLY to `cto`; other
      experts do not respond and the turn is marked `isMention=1`
      in the DB (verify with `sqlite3 $COUNCIL_HOME/council.db "SELECT
    role, expert_slug, is_mention FROM chat_turns ORDER BY seq DESC
    LIMIT 5;"`).
- [ ] `@cto @sre what about reliability?` routes to both, in panel
      order.
- [ ] `@unknown ...` surfaces a helpful "no such expert" error and
      does NOT persist the user turn.
- [ ] After an `@mention` exchange, the next general turn (no
      `@mention`) shows that the non-mentioned experts can see the
      prior `@mention` exchange in their context.
- [ ] `@mention` syntax in a 1:1 chat (`council chat cto`) is passed
      through verbatim — the parser is bypassed.

## 9. `@convene` structured debate inside chat

- [ ] In a panel chat, `@convene Should we deprecate the v1 API?`
      triggers a structured debate, streams each phase, and persists
      every debate turn into the chat history.
- [ ] `@convene` with no topic surfaces an error and does not start a
      debate.
- [ ] Cancel mid-debate (Ctrl+C) cleanly: the chat session is
      preserved, the turns from completed phases stay persisted, and
      re-launching the chat resumes from the next user prompt.

## 10. Persona expert documents

- [ ] Create a persona expert: `council expert create --persona --slug alex
    --name "Alex" --role "Persona expert" --expertise "writing,analysis"
    --stance "reflective"`.
- [ ] Place 2–3 markdown files in
      `$COUNCIL_HOME/experts/alex/docs/`.
- [ ] `council chat alex` shows a one-time progress banner as
      documents are extracted, indexed, and the persona profile is
      analyzed; first response uses the profile's voice.
- [ ] Modify one document, add another, delete a third; relaunch
      `council chat alex`: progress banner reports the incremental
      processing (1 modified, 1 new, 1 removed) without
      re-processing the unchanged docs.
- [ ] Empty the docs folder and relaunch: a one-line info message
      explains the persona is running as a generic expert.
- [ ] `sqlite3 $COUNCIL_HOME/council.db "SELECT count(*) FROM
    document_index WHERE source_slug = 'alex';"` reflects the
      current set of indexed documents.
- [ ] Symlink the docs folder root to another directory and try
      `council chat alex`: the symlinked root is rejected up front
      with a clear security message (refusing to follow it for
      confinement safety).

## 11. Edge cases

### 11.1 Not-found / missing inputs

- [ ] `council experts inspect ghost` exits non-zero with a clear
      "no such expert" message, no stack trace.
- [ ] `council panel inspect ghost-panel` likewise.
- [ ] `council chat ghost` likewise.
- [ ] `council convene --template ghost-template "..."` prints the
      list of built-in templates and exits non-zero.

### 11.2 Cancellation (Ctrl+C)

- [ ] Ctrl+C during `council convene` (mid-stream): aborts within
      ~1 s, persists any completed turns, prints a one-line "aborted"
      message, exits non-zero. No orphan Copilot processes
      (`pgrep -f copilot` after cancellation should be empty).
- [ ] Ctrl+C during `council chat` (mid-stream): the in-flight
      response is discarded cleanly; the session remains active and
      resumable.
- [ ] Ctrl+C during persona document processing: partial progress is
      preserved (already-processed files stay tracked), and re-running
      picks up where it left off.

### 11.3 Long conversations

- [ ] In a 1:1 chat, send 30+ alternating turns. Each turn streams
      without OOM, the renderer scrolls cleanly, and `council chat
    cto --history` shows the full session length.
- [ ] After a long session, exit and `council chat cto` again: the
      history is reloaded; the model continues coherently
      (auto-summary, if implemented, kicks in without errors).
- [ ] In a panel chat, accumulate 20+ turns and verify that
      context-window overflow is handled gracefully (no silent
      truncation of new user prompts; explicit warning if approached).

### 11.4 Network and auth failures

- [ ] Revoke Copilot auth (`gh auth logout`) and run any LLM-touching
      command: a `NOT_AUTHENTICATED` error is shown with the exact
      remediation (`gh auth login`), exit code non-zero.
- [ ] Disable network mid-stream (block egress for a few seconds): a
      `NETWORK` error is reported, marked `recoverable: true`, and the
      command does not silently succeed.

### 11.5 Filesystem edge cases

- [ ] A `panels/<name>.yaml` that fails Zod validation is rejected on
      `council panel inspect`/`edit` with a precise field-level error.
- [ ] A corrupt `expert_library` row whose YAML file is missing
      surfaces a clean "missing YAML" error rather than crashing
      `council experts list`.
- [ ] Read-only `$COUNCIL_HOME` (chmod 555) surfaces a clear
      permission error on the first write, no partial state.

---

## Sign-off

When every box above is ✅ on the release candidate build, paste the
Copilot SDK version, Council version, OS, and Node.js version into the
release PR before merging.

```
Council version : <output of `council --version`>
Copilot SDK     : <output of `node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).dependencies['@github/copilot-sdk']"`>
Node.js         : <output of `node --version`>
OS              : <e.g. macOS 14.5 / Ubuntu 24.04 / Windows 11>
Tester          : <github-handle>
Date            : <YYYY-MM-DD>
```
