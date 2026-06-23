export const ROUTES = {
  home: "/",
  panels: "/panels",
  panelNew: "/panels/new",
  panelDetail: "/panels/:name",
  experts: "/experts",
  expertNew: "/experts/new",
  expertEdit: "/experts/:slug/edit",
  expertDelete: "/experts/:slug/delete",
  expertDocs: "/experts/:slug/docs",
  expertTrain: "/experts/:slug/train",
  expertDetail: "/experts/:slug",
  sessions: "/sessions",
  sessionDetail: "/sessions/:id",
  chats: "/chats",
  settings: "/settings",
} as const;

const NAV_PREFIXES: readonly { readonly prefix: string; readonly id: string }[] = [
  { prefix: "/panels", id: "panels" },
  { prefix: "/experts", id: "experts" },
  { prefix: "/sessions", id: "sessions" },
  { prefix: "/chats", id: "chats" },
  { prefix: "/settings", id: "settings" },
];

export function routeToNavId(pathname: string): string {
  for (const { prefix, id } of NAV_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return id;
  }
  return "home";
}
