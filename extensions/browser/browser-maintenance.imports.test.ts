import { expect, it, vi } from "vitest";

vi.mock("./src/browser-control-state.js", () => {
  throw new Error("Empty session cleanup must not load the Browser control runtime");
});
vi.mock("./src/config/config.js", () => {
  throw new Error("Empty session cleanup must not load Browser config runtime");
});
vi.mock("./src/browser/cdp.helpers.js", () => {
  throw new Error("Empty session cleanup must not load CDP transports");
});
vi.mock("./src/browser/client.js", () => {
  throw new Error("Empty session cleanup must not load the Browser client");
});
vi.mock("./src/browser/trash.js", () => {
  throw new Error("Session cleanup must not load the Browser trash runtime");
});

import { closeTrackedBrowserTabsForSessions } from "./browser-maintenance.js";

it("cleans a session without owned tabs before loading Browser transports", async () => {
  await expect(
    closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:unused"] }),
  ).resolves.toBe(0);
});
