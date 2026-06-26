import { matchPath } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";

export const ROUTES = {
  home: "/",
  onboarding: "/onboarding",
  panels: "/panels",
  panelNew: "/panels/new",
  panelCompose: "/panels/compose",
  panelMembers: "/panels/:name/members",
  panelDelete: "/panels/:name/delete",
  panelDetail: "/panels/:name",
  convenePrompt: "/convene/:panel",
  debateRun: "/convene/:panel/run",
  experts: "/experts",
  expertNew: "/experts/new",
  expertEdit: "/experts/:slug/edit",
  expertDelete: "/experts/:slug/delete",
  expertDocs: "/experts/:slug/docs",
  expertTrain: "/experts/:slug/train",
  expertDetail: "/experts/:slug",
  sessions: "/sessions",
  sessionDetail: "/sessions/:id",
  sessionConclude: "/sessions/:id/conclude",
  sessionExport: "/sessions/:id/export",
  chats: "/chats",
  chatExpert: "/chat/expert/:slug",
  chatPanel: "/chat/panel/:name",
  settings: "/settings",
} as const;

const NAV_PREFIXES: readonly { readonly prefix: string; readonly id: string }[] = [
  { prefix: "/panels", id: "panels" },
  { prefix: "/experts", id: "experts" },
  { prefix: "/sessions", id: "sessions" },
  { prefix: "/chats", id: "chats" },
  { prefix: "/chat", id: "chats" },
  { prefix: "/settings", id: "settings" },
];

export function routeToNavId(pathname: string): string {
  for (const { prefix, id } of NAV_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return id;
  }
  return "home";
}

const SEP = " › ";

/**
 * Decode and sanitize an untrusted breadcrumb ENTITY segment (panel name,
 * expert slug, session id) sourced from the URL/route params. The raw value is
 * URL-encoded and ultimately DB/LLM-derived, so it must be decoded and forced
 * onto a single terminal line before it can be rendered to `<Text>`.
 */
function entitySegment(raw: string | undefined): string {
  if (raw === undefined) return "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return toSingleLineDisplay(decoded);
}

type BreadcrumbParams = Readonly<Record<string, string | undefined>>;

interface BreadcrumbRoute {
  readonly pattern: string;
  readonly build: (params: BreadcrumbParams) => readonly string[];
}

// Most-specific-first: static segments precede their `:param` siblings so e.g.
// `/panels/new` resolves to its own crumb instead of the panel-detail entity.
const BREADCRUMB_ROUTES: readonly BreadcrumbRoute[] = [
  { pattern: ROUTES.debateRun, build: (p) => ["Panels", entitySegment(p.panel), "Debate"] },
  { pattern: ROUTES.convenePrompt, build: (p) => ["Panels", entitySegment(p.panel), "Convene"] },
  { pattern: ROUTES.panelNew, build: () => ["Panels", "New"] },
  { pattern: ROUTES.panelCompose, build: () => ["Panels", "Compose"] },
  { pattern: ROUTES.panelMembers, build: (p) => ["Panels", entitySegment(p.name), "Members"] },
  { pattern: ROUTES.panelDelete, build: (p) => ["Panels", entitySegment(p.name), "Delete"] },
  { pattern: ROUTES.panelDetail, build: (p) => ["Panels", entitySegment(p.name)] },
  { pattern: ROUTES.panels, build: () => ["Panels"] },
  { pattern: ROUTES.expertNew, build: () => ["Experts", "New"] },
  { pattern: ROUTES.expertEdit, build: (p) => ["Experts", entitySegment(p.slug), "Edit"] },
  { pattern: ROUTES.expertDelete, build: (p) => ["Experts", entitySegment(p.slug), "Delete"] },
  { pattern: ROUTES.expertDocs, build: (p) => ["Experts", entitySegment(p.slug), "Documents"] },
  { pattern: ROUTES.expertTrain, build: (p) => ["Experts", entitySegment(p.slug), "Train"] },
  { pattern: ROUTES.expertDetail, build: (p) => ["Experts", entitySegment(p.slug)] },
  { pattern: ROUTES.experts, build: () => ["Experts"] },
  {
    pattern: ROUTES.sessionConclude,
    build: (p) => ["Debates", entitySegment(p.id), "Conclusion"],
  },
  { pattern: ROUTES.sessionExport, build: (p) => ["Debates", entitySegment(p.id), "Export"] },
  { pattern: ROUTES.sessionDetail, build: (p) => ["Debates", entitySegment(p.id)] },
  { pattern: ROUTES.sessions, build: () => ["Debates"] },
  { pattern: ROUTES.chatExpert, build: (p) => ["Conversations", entitySegment(p.slug)] },
  { pattern: ROUTES.chatPanel, build: (p) => ["Conversations", entitySegment(p.name)] },
  { pattern: ROUTES.chats, build: () => ["Conversations"] },
  { pattern: ROUTES.settings, build: () => ["Settings"] },
  { pattern: ROUTES.onboarding, build: () => ["Onboarding"] },
  { pattern: ROUTES.home, build: () => ["Home"] },
];

/**
 * Build a depth- and entity-aware breadcrumb for a concrete pathname by
 * matching the most-specific route first and joining its labelled segments
 * with ` › `. Static section labels are trusted; ENTITY segments are decoded
 * and sanitized via {@link entitySegment}. Pure — no React or app state.
 */
export function routeToBreadcrumb(pathname: string): string {
  for (const route of BREADCRUMB_ROUTES) {
    const match = matchPath(route.pattern, pathname);
    if (match !== null) {
      return route
        .build((match.params ?? {}) as BreadcrumbParams)
        .filter((segment) => segment.length > 0)
        .join(SEP);
    }
  }
  return "Council";
}
