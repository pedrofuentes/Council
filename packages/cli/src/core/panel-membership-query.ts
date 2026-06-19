/**
 * Query an expert's panel memberships with co-member display names
 * for the cross-panel awareness prompt section (Roadmap 7.2 + 7.3).
 *
 * Joins `panel_members` -> `panel_library` -> `panel_members` again
 * (for co-members) -> `expert_library` (for co-member display names).
 * The expert themselves is excluded from `coMembers`. Co-members whose
 * row is missing from `expert_library` fall back to their slug so the
 * presence of a panel is never silently dropped.
 *
 * Results are ordered by `panel_library.updated_at` DESC (most
 * recently active first) and capped at `PANEL_MEMBERSHIPS_LIMIT` at
 * the DB layer so the co-member fan-out stays bounded regardless of
 * how many panels the expert belongs to.
 */
import type { CouncilDatabase } from "../memory/db.js";
import {
  PANEL_MEMBERSHIPS_LIMIT,
  type PanelMembership,
} from "./prompt-builder.js";

export async function getExpertPanelMemberships(
  expertSlug: string,
  db: CouncilDatabase,
): Promise<readonly PanelMembership[]> {
  // Apply the prompt-budget cap at the DB level so a member of many
  // panels does not pay N+1 co-member queries for rows that the prompt
  // renderer will discard anyway.
  const panels = await db
    .selectFrom("panel_members as pm")
    .innerJoin("panel_library as pl", "pl.name", "pm.panel_name")
    .where("pm.expert_slug", "=", expertSlug)
    .select(["pl.name", "pl.description", "pl.updated_at"])
    .orderBy("pl.updated_at", "desc")
    .limit(PANEL_MEMBERSHIPS_LIMIT)
    .execute();

  if (panels.length === 0) return [];

  const memberships: PanelMembership[] = [];
  for (const panel of panels) {
    const coRows = await db
      .selectFrom("panel_members as pm")
      .leftJoin("expert_library as el", "el.slug", "pm.expert_slug")
      .where("pm.panel_name", "=", panel.name)
      .where("pm.expert_slug", "!=", expertSlug)
      .select(["pm.expert_slug", "pm.position", "el.display_name"])
      .orderBy("pm.position", "asc")
      .execute();
    const coMembers = coRows.map((r) => r.display_name ?? r.expert_slug);
    const membership: PanelMembership = {
      panelName: panel.name,
      coMembers,
      ...(panel.description !== null ? { description: panel.description } : {}),
    };
    memberships.push(membership);
  }
  return memberships;
}
