import { describe, expect, it } from "vitest";
import { routeToNavId } from "../../../src/tui/router/routes.js";

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
