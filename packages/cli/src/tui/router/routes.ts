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
  {
    pattern: ROUTES.debateRun,
    build: (p) => ["Council", "Panels", entitySegment(p.panel), "Debate"],
  },
  {
    pattern: ROUTES.convenePrompt,
    build: (p) => ["Council", "Panels", entitySegment(p.panel), "Convene"],
  },
  { pattern: ROUTES.panelNew, build: () => ["Council", "Panels", "New"] },
  { pattern: ROUTES.panelCompose, build: () => ["Council", "Panels", "Compose"] },
  {
    pattern: ROUTES.panelMembers,
    build: (p) => ["Council", "Panels", entitySegment(p.name), "Members"],
  },
  {
    pattern: ROUTES.panelDelete,
    build: (p) => ["Council", "Panels", entitySegment(p.name), "Delete"],
  },
  { pattern: ROUTES.panelDetail, build: (p) => ["Council", "Panels", entitySegment(p.name)] },
  { pattern: ROUTES.panels, build: () => ["Council", "Panels"] },
  { pattern: ROUTES.expertNew, build: () => ["Council", "Experts", "New"] },
  {
    pattern: ROUTES.expertEdit,
    build: (p) => ["Council", "Experts", entitySegment(p.slug), "Edit"],
  },
  {
    pattern: ROUTES.expertDelete,
    build: (p) => ["Council", "Experts", entitySegment(p.slug), "Delete"],
  },
  {
    pattern: ROUTES.expertDocs,
    build: (p) => ["Council", "Experts", entitySegment(p.slug), "Documents"],
  },
  {
    pattern: ROUTES.expertTrain,
    build: (p) => ["Council", "Experts", entitySegment(p.slug), "Train"],
  },
  { pattern: ROUTES.expertDetail, build: (p) => ["Council", "Experts", entitySegment(p.slug)] },
  { pattern: ROUTES.experts, build: () => ["Council", "Experts"] },
  {
    pattern: ROUTES.sessionConclude,
    build: (p) => ["Council", "Debates", entitySegment(p.id), "Conclusion"],
  },
  {
    pattern: ROUTES.sessionExport,
    build: (p) => ["Council", "Debates", entitySegment(p.id), "Export"],
  },
  { pattern: ROUTES.sessionDetail, build: (p) => ["Council", "Debates", entitySegment(p.id)] },
  { pattern: ROUTES.sessions, build: () => ["Council", "Debates"] },
  { pattern: ROUTES.chatExpert, build: (p) => ["Council", "Conversations", entitySegment(p.slug)] },
  { pattern: ROUTES.chatPanel, build: (p) => ["Council", "Conversations", entitySegment(p.name)] },
  { pattern: ROUTES.chats, build: () => ["Council", "Conversations"] },
  { pattern: ROUTES.settings, build: () => ["Council", "Settings"] },
  { pattern: ROUTES.onboarding, build: () => ["Council", "Onboarding"] },
  { pattern: ROUTES.home, build: () => ["Council"] },
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
