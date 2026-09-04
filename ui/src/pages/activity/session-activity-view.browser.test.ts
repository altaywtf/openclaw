import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { ApplicationContext } from "../../app/context.ts";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/settings.css";
import "../../styles/activity.css";
import { renderSessionActivityView } from "./session-activity-view.ts";

afterEach(() => {
  render(null, document.body);
});

it.each([null, "person"])(
  "keeps activity content at the same vertical position during refresh (person: %s)",
  async (personId) => {
    await page.viewport(900, 700);
    const props: Parameters<typeof renderSessionActivityView>[0] = {
      context: {
        basePath: "",
        navigate: vi.fn(),
        gateway: { snapshot: { hello: null } },
        agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
        agentSelection: { state: { selectedId: "main" } },
        sessions: { state: { result: { sessions: [] } } },
      } as unknown as ApplicationContext,
      filters: { personId, query: "", time: "7d" },
      presenceViewers: [],
      loading: false,
      result: {
        ts: 1,
        path: "",
        count: 0,
        sessions: [],
        defaults: { model: null, modelProvider: null, contextTokens: null },
        people: [{ identity: { type: "profile", id: "person" }, label: "Person", sessionCount: 0 }],
      },
      expandedAutomationDays: new Set(),
      onRetry: vi.fn(),
      onAutomationDayToggle: vi.fn(),
      onFiltersChange: vi.fn(),
    };
    render(renderSessionActivityView(props), document.body);
    const main = document.querySelector<HTMLElement>(".activity-feed__main")!;
    const content = main.querySelector<HTMLElement>(
      personId ? "[data-activity-identity]" : ".activity-feed__summary",
    )!;
    expect(getComputedStyle(main).overflowY).toBe("auto");
    const top = content.getBoundingClientRect().top;
    expect(content.getBoundingClientRect().height).toBeGreaterThan(0);

    for (const loading of [true, false, true, false]) {
      render(renderSessionActivityView({ ...props, loading }), document.body);
      expect(Math.abs(content.getBoundingClientRect().top - top)).toBeLessThan(1);
      expect(main.textContent).not.toContain("Loading");
    }

    render(
      renderSessionActivityView({ ...props, result: undefined, loading: true }),
      document.body,
    );
    expect(main.querySelector('[role="status"]')?.textContent).toContain("Loading");
  },
);
