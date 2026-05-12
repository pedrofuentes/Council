# Plan: Cross-Panel Awareness + Panel Membership Tracking (Roadmap 7.2 + 7.3)

## Increments (single PR)

1. **RED — Tests** (test commit)
   - Extend tests/unit/core/prompt-builder.test.ts: PanelMembership rendering, 5-cap, empty array, buildSystemPrompt section integration (with/without persona, ordering).
   - Add tests/unit/core/panel-membership-query.test.ts: getExpertPanelMemberships joins panel_members + panel_library + co-members, excludes self, orders by updated_at DESC, returns display names.

2. **GREEN — Impl** (feat commit)
   - src/core/prompt-builder.ts: add PanelMembership interface, renderPanelMemberships(), extend buildSystemPrompt() with panelMemberships? parameter.
   - src/core/panel-membership-query.ts: getExpertPanelMemberships().
   - src/cli/commands/chat.ts: load memberships for 1:1 chat, pass into buildExpertSpec/buildSystemPrompt. Panel chat path unchanged.

3. **Verify** — pnpm test, build, lint, typecheck. Invoke Sentinel. Merge.

## Notes
- Section ordering: PERSONA PROFILE (if present) precedes PANEL MEMBERSHIPS; CURRENT TASK always last.
- Convene uses transient panels table (not panel_library), so no panel_members wiring needed there.
- Panel.create + template migration already populate panel_members.
