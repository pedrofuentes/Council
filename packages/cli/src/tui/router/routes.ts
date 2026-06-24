export const ROUTES = {
  home: "/",
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
