import { describe, expect, it } from "vitest";
import { routeToBreadcrumb, routeToNavId } from "../../../src/tui/router/routes.js";

describe("routeToNavId", () => {
  it("maps list and detail paths to the nav id", () => {
    expect(routeToNavId("/")).toBe("home");
    expect(routeToNavId("/panels")).toBe("panels");
    expect(routeToNavId("/panels/acme")).toBe("panels");
    expect(routeToNavId("/experts/cto")).toBe("experts");
    expect(routeToNavId("/sessions/abc")).toBe("sessions");
    expect(routeToNavId("/settings")).toBe("settings");
    expect(routeToNavId("/chats")).toBe("chats");
  });
  it("falls back to home for unknown paths", () => {
    expect(routeToNavId("/nope")).toBe("home");
  });
});

describe("routeToBreadcrumb", () => {
  it("maps the root and top-level section routes", () => {
    expect(routeToBreadcrumb("/")).toBe("Home");
    expect(routeToBreadcrumb("/panels")).toBe("Panels");
    expect(routeToBreadcrumb("/experts")).toBe("Experts");
    expect(routeToBreadcrumb("/sessions")).toBe("Debates");
    expect(routeToBreadcrumb("/chats")).toBe("Conversations");
    expect(routeToBreadcrumb("/settings")).toBe("Settings");
    expect(routeToBreadcrumb("/onboarding")).toBe("Onboarding");
  });

  it("includes the entity for detail and nested routes", () => {
    expect(routeToBreadcrumb("/panels/acme")).toBe("Panels › acme");
    expect(routeToBreadcrumb("/panels/acme/members")).toBe("Panels › acme › Members");
    expect(routeToBreadcrumb("/experts/cto")).toBe("Experts › cto");
    expect(routeToBreadcrumb("/experts/cto/train")).toBe("Experts › cto › Train");
    expect(routeToBreadcrumb("/sessions/abc")).toBe("Debates › abc");
    expect(routeToBreadcrumb("/sessions/abc/conclude")).toBe("Debates › abc › Conclusion");
    expect(routeToBreadcrumb("/sessions/abc/export")).toBe("Debates › abc › Export");
    expect(routeToBreadcrumb("/chat/expert/cto")).toBe("Conversations › cto");
    expect(routeToBreadcrumb("/chat/panel/strategy")).toBe("Conversations › strategy");
  });

  it("maps the convene flow with the panel entity", () => {
    expect(routeToBreadcrumb("/convene/acme")).toBe("Panels › acme › Convene");
    expect(routeToBreadcrumb("/convene/acme/run")).toBe("Panels › acme › Debate");
  });

  it("prefers static segments over the entity route", () => {
    expect(routeToBreadcrumb("/panels/new")).toBe("Panels › New");
    expect(routeToBreadcrumb("/experts/new")).toBe("Experts › New");
  });

  it("decodes URL-encoded entity params", () => {
    expect(routeToBreadcrumb("/panels/growth%20council")).toBe("Panels › growth council");
  });

  it("single-lines control sequences in untrusted entity params", () => {
    const crumb = routeToBreadcrumb("/panels/" + encodeURIComponent("Growth\r\nCouncil"));
    expect(crumb).toBe("Panels › Growth Council");
    expect(crumb).not.toContain("\r");
    expect(crumb).not.toContain("\n");
  });

  it("strips ANSI escape sequences from entity params", () => {
    const crumb = routeToBreadcrumb("/experts/" + encodeURIComponent("cto\u001b[31mx"));
    expect(crumb).not.toContain("\u001b");
    expect(crumb).not.toContain("[31m");
  });

  it("falls back to Council for unknown paths", () => {
    expect(routeToBreadcrumb("/nope/zzz")).toBe("Council");
  });
});
