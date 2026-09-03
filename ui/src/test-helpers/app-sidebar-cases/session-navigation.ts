import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { SESSION_NAVIGATION_INTENT_EVENT } from "../../lib/sessions/navigation-handoff.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";

describe("AppSidebar retained session navigation", () => {
  it("opens dashboard sessions in the expanded dashboard presentation", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessions("main", ["agent:main:a", "agent:main:b"]);
    sessions.state.result!.sessions[1]!.boardFace = "dashboard";
    const { sidebar } = await mountSidebar(gateway, sessions);
    const navigation = vi.fn();
    sidebar.onNavigate = navigation;

    (sidebar as typeof sidebar & { selectSession: (key: string) => void }).selectSession(
      "agent:main:b",
    );

    expect(navigation).toHaveBeenCalledWith("dashboard", {
      pathname: "/dashboard/main/b",
      search: "?dashboard=expanded",
    });
    const href = Array.from(sidebar.querySelectorAll<HTMLAnchorElement>("a"))
      .find((link) => link.getAttribute("href")?.startsWith("/dashboard/main/b"))
      ?.getAttribute("href");
    expect(new URL(href!, "http://openclaw.test").searchParams.get("dashboard")).toBe("expanded");
  });

  it("cancels a pending retained navigation when a newer session wins", async () => {
    let pendingCommit: (() => boolean) | undefined;
    const handleIntent = (event: Event) => {
      const intent = event as CustomEvent<{ commit: () => boolean; sessionKey: string }>;
      if (intent.detail.sessionKey === "agent:main:b") {
        pendingCommit = intent.detail.commit;
        event.preventDefault();
      }
    };
    window.addEventListener(SESSION_NAVIGATION_INTENT_EVENT, handleIntent);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:a", "agent:main:b"]),
    );
    const navigation = vi.fn();
    sidebar.onNavigate = navigation;
    const selectSession = (sidebar as typeof sidebar & { selectSession: (key: string) => void })
      .selectSession;

    try {
      selectSession("agent:main:b");
      expect(navigation).not.toHaveBeenCalled();
      selectSession("agent:main:a");

      expect(pendingCommit?.()).toBe(false);
      expect(navigation).toHaveBeenCalledOnce();
      expect(navigation).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/main/a" }),
      );
    } finally {
      window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, handleIntent);
    }
  });

  it("refuses to commit retained navigation after the sidebar disconnects", async () => {
    let pendingCommit: (() => boolean) | undefined;
    const handleIntent = (event: Event) => {
      pendingCommit = (event as CustomEvent<{ commit: () => boolean }>).detail.commit;
      event.preventDefault();
    };
    window.addEventListener(SESSION_NAVIGATION_INTENT_EVENT, handleIntent);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:a", "agent:main:b"]),
    );
    const navigation = vi.fn();
    sidebar.onNavigate = navigation;
    const selectSession = (sidebar as typeof sidebar & { selectSession: (key: string) => void })
      .selectSession;

    try {
      selectSession("agent:main:b");
      sidebar.remove();
      expect(pendingCommit?.()).toBe(false);
      expect(navigation).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, handleIntent);
    }
  });
});
