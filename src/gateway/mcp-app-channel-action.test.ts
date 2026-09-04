import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTicket: vi.fn(),
  getView: vi.fn(),
  peekRuntime: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: mocks.peekRuntime,
}));
vi.mock("../agents/mcp-ui-resource.js", () => ({
  getMcpAppViewLease: mocks.getView,
}));
vi.mock("./mcp-app-standalone.js", () => ({
  createMcpAppStandaloneTicket: mocks.createTicket,
}));

import { getGatewayBrowserOrigin, prepareGatewayBrowserOrigin } from "./browser-origin.js";
import { materializeMcpAppChannelPresentation } from "./mcp-app-channel-action.js";

const nowMs = 1_800_000_000_000;
const runtime = { sessionId: "runtime-session", mcpAppsEnabled: true };
const view = {
  viewId: "view-latest",
  sessionId: runtime.sessionId,
  expiresAtMs: nowMs + 60_000,
  html: "do-not-emit-html",
  toolInput: { privateInput: "do-not-emit-input" },
  toolResult: { privateResult: "do-not-emit-result" },
};

function resetMcpAppChannelOrigin() {
  prepareGatewayBrowserOrigin({ origin: "https://reset.test", reachability: "tailnet" })();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMcpAppChannelOrigin();
  mocks.peekRuntime.mockReturnValue(runtime);
  mocks.getView.mockReturnValue(view);
  mocks.createTicket.mockReturnValue({
    ticket: "opaque-ticket",
    url: "/__openclaw__/mcp-app#opaque-ticket",
    expiresAtMs: nowMs + 60_000,
  });
});

describe("MCP App channel origin", () => {
  it("stores one lifecycle-owned Serve or Funnel snapshot", () => {
    const clearServe = prepareGatewayBrowserOrigin({
      origin: "https://node.tailnet.ts.net",
      reachability: "tailnet",
    });
    const clearFunnel = prepareGatewayBrowserOrigin({
      origin: "https://public.example.ts.net/",
      reachability: "internet",
    });

    expect(getGatewayBrowserOrigin()).toEqual({
      origin: "https://public.example.ts.net",
      reachability: "internet",
    });
    clearServe();
    expect(getGatewayBrowserOrigin()).toBeDefined();
    clearFunnel();
    expect(getGatewayBrowserOrigin()).toBeUndefined();
  });

  it.each(["http://node.test", "https://%75@node.test", "https://node.test/path"])(
    "rejects unsafe origin %s",
    (origin) => {
      expect(() => prepareGatewayBrowserOrigin({ origin, reachability: "tailnet" })).toThrow(
        "absolute HTTPS origin",
      );
    },
  );
});

describe("materializeMcpAppChannelPresentation", () => {
  it("mints late and emits only one typed action with an opaque ticket", () => {
    prepareGatewayBrowserOrigin({
      origin: "https://node.tailnet.ts.net",
      reachability: "tailnet",
    });

    const presentation = materializeMcpAppChannelPresentation({
      sessionKey: "agent:main:do-not-emit-session",
      view: { viewId: "view-latest", title: "do-not-emit-title" } as never,
      nowMs,
    });

    expect(mocks.createTicket).toHaveBeenCalledOnce();
    expect(presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Open app",
              action: {
                type: "web-app",
                url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
              },
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(presentation);
    for (const privateValue of [
      view.html,
      "do-not-emit-input",
      "do-not-emit-result",
      "do-not-emit-session",
      "do-not-emit-title",
      view.viewId,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each([
    ["missing origin", resetMcpAppChannelOrigin],
    ["missing view", () => mocks.getView.mockReturnValue(undefined)],
    ["expired view", () => mocks.getView.mockReturnValue({ ...view, expiresAtMs: nowMs })],
    ["ticket capacity", () => mocks.createTicket.mockReturnValue(undefined)],
  ])("omits the action for %s", (_name, arrange) => {
    prepareGatewayBrowserOrigin({
      origin: "https://node.tailnet.ts.net",
      reachability: "tailnet",
    });
    arrange();

    expect(
      materializeMcpAppChannelPresentation({
        sessionKey: "agent:main:main",
        view: { viewId: "view-latest" },
        nowMs,
      }),
    ).toBeUndefined();
  });
});
