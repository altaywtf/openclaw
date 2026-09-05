import { render } from "lit";
import { expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  contextWith,
  deferred,
  publishModelCatalog,
  renderControl,
} from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

const starter: ModelCatalogEntry = { id: "starter", name: "Starter", provider: "provider" };
const chosen: ModelCatalogEntry = { id: "chosen", name: "Chosen", provider: "provider" };
const added: ModelCatalogEntry = { id: "added", name: "Added", provider: "provider" };

it("updates an open picker from scoped publications without restoring stale draft preferences", async () => {
  const { context, request } = contextWith([starter, chosen]);
  const selectionChanged = vi.fn();
  const control = new NewSessionModelControl(() => undefined, selectionChanged);
  control.load(context, "main", true, { preference: { model: "provider/starter" } });
  await waitForFast(() => expect(control.selected).toBe("provider/starter"));
  const container = renderControl(control, context);
  const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker")!;
  container.querySelector<HTMLButtonElement>('[data-chat-model-option="provider/chosen"]')!.click();
  picker.open = true;
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
  request.mockClear();
  control.thinkingLevel = "high";
  control.contextWindow = "extended";
  control.fastMode = true;
  selectionChanged.mockClear();
  request.mockResolvedValue({ models: [chosen, added] });

  publishModelCatalog(context);
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());
  await waitForFast(() => {
    render(
      control.render({ agentId: "main", context, agent: { id: "main" }, sending: false }),
      container,
    );
    expect(container.querySelector('[data-chat-model-option="provider/added"]')).not.toBeNull();
  });
  expect(picker.open).toBe(true);
  expect(container.querySelector('[data-chat-model-option="provider/starter"]')).toBeNull();
  expect(control.selected).toBe("provider/chosen");
  expect(control.thinkingLevel).toBe("high");
  expect(control.contextWindow).toBe("extended");
  expect(control.fastMode).toBe(true);
  expect(selectionChanged).not.toHaveBeenCalled();
  expect(
    request.mock.calls.every(([method, params]) => method === "models.list" && !params.refresh),
  ).toBe(true);
  control.reset();
  publishModelCatalog(context);
  expect(request).toHaveBeenCalledOnce();
});

it.each(["invalidate", "agent roundtrip", "disable", "reconnect"])(
  "rejects a late same-client catalog after %s",
  async (transition) => {
    const retired = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([added]);
    request.mockReturnValueOnce(retired.promise);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    if (transition === "invalidate") {
      control.invalidate();
    } else if (transition === "agent roundtrip") {
      control.load(context, "other", true);
    } else if (transition === "disable") {
      control.load(context, "main", false);
    } else {
      Object.assign(context.gateway, {
        snapshot: { ...context.gateway.snapshot, phase: "reconnecting" },
      });
      control.load(context, "main", true);
      Object.assign(context.gateway, {
        snapshot: { ...context.gateway.snapshot, phase: "connected" },
      });
    }
    control.load(context, "main", true);
    await waitForFast(() => expect(renderControl(control, context).textContent).toContain("Added"));
    retired.resolve({ models: [starter] });
    await retired.promise;
    await Promise.resolve();
    const container = renderControl(control, context);
    expect(container.querySelector('[data-chat-model-option="provider/added"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-model-option="provider/starter"]')).toBeNull();
    control.reset();
  },
);

it("keeps previous choices usable and reports a failed publication reload", async () => {
  const { context, request } = contextWith([chosen]);
  const control = new NewSessionModelControl(() => undefined);
  control.load(context, "main", true);
  await waitForFast(() => expect(renderControl(control, context).textContent).toContain("Chosen"));
  request.mockRejectedValueOnce(new Error("catalog read failed"));
  publishModelCatalog(context);
  await waitForFast(() =>
    expect(renderControl(control, context).textContent).toContain("showing previous choices"),
  );
  const container = renderControl(control, context);
  const option = container.querySelector<HTMLButtonElement>(
    '[data-chat-model-option="provider/chosen"]',
  )!;
  expect(option.disabled).toBe(false);
  option.click();
  expect(control.selected).toBe("provider/chosen");
  expect(container.textContent).not.toContain("No models available");
  control.reset();
});

it("reads a fresh snapshot when an inactive picker returns", async () => {
  const { context, request } = contextWith([chosen]);
  const control = new NewSessionModelControl(() => undefined);
  control.load(context, "main", true);
  await waitForFast(() => expect(renderControl(control, context).textContent).toContain("Chosen"));
  control.selected = "provider/chosen";
  control.thinkingLevel = "high";
  control.load(context, "main", false);
  request.mockResolvedValue({ models: [chosen, added] });
  publishModelCatalog(context);
  expect(request).toHaveBeenCalledOnce();

  control.load(context, "main", true);
  await waitForFast(() => expect(renderControl(control, context).textContent).toContain("Added"));
  expect(control.selected).toBe("provider/chosen");
  expect(control.thinkingLevel).toBe("high");
  control.reset();
});

it.each(["provider/chosen", "provider/remembered"])(
  "retains a recorded discovery warning and %s until snapshot recovery",
  async (model) => {
    const { context, request } = contextWith([chosen]);
    request.mockResolvedValue({ models: [chosen], refreshFailed: true });
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true, {
      preference: { model, thinkingLevel: "high" },
    });
    await waitForFast(() =>
      expect(renderControl(control, context).textContent).toContain("showing previous choices"),
    );
    const reread = deferred<{ models: ModelCatalogEntry[]; refreshFailed: boolean }>();
    request.mockReturnValueOnce(reread.promise);
    const picker = renderControl(control, context).querySelector<HTMLDetailsElement>(
      ".chat-controls__model-picker",
    )!;
    picker.open = true;
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(renderControl(control, context).textContent).toContain("showing previous choices");
    reread.resolve({ models: [chosen, added], refreshFailed: true });
    await waitForFast(() => expect(renderControl(control, context).textContent).toContain("Added"));
    expect(renderControl(control, context).textContent).toContain("showing previous choices");

    request.mockResolvedValue({ models: [chosen, added] });
    publishModelCatalog(context);
    await waitForFast(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-model-catalog-state="error"]'),
      ).toBeNull(),
    );
    expect(control.selected).toBe(model);
    expect(control.thinkingLevel).toBe("high");
    control.reset();
  },
);
